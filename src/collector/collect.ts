import { chromium, type Page, type Response } from "playwright";

import type { SiteSnapshot } from "../contracts/index.js";
import { CollectorError, CollectorErrorCode } from "./errors.js";
import { observeDom } from "./observe.js";
import { parseCollectorOptions, type CollectorOptions, type ParsedCollectorOptions } from "./options.js";
import {
  buildSiteSnapshot,
  canonicalizeHttpUrl,
  discoverCrawlTargets,
  isAllowedHttpUrl,
  normalizeAllowedOrigins,
  type DomObservation,
  type ObservedPage,
} from "./snapshot.js";

type CrawlItem = Readonly<{ url: string; depth: number }>;
const READ_ONLY_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type CollectorDependencies = Readonly<{
  now?: () => Date;
}>;

function safeUrlDescription(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid URL";
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

async function navigateOnce(
  page: Page,
  item: CrawlItem,
  options: ParsedCollectorOptions,
  getBlockedNavigation: () => string | undefined,
): Promise<Response> {
  let response: Response | null;
  try {
    response = await page.goto(item.url, {
      timeout: options.navigationTimeoutMs,
      waitUntil: "load",
    });
  } catch (error) {
    const blockedNavigation = getBlockedNavigation();
    if (blockedNavigation !== undefined) {
      throw new CollectorError(
        CollectorErrorCode.redirectDisallowed,
        `Navigation was redirected outside the configured origins from ${safeUrlDescription(item.url)}.`,
        {},
        error,
      );
    }
    if (isTimeoutError(error)) {
      throw new CollectorError(
        CollectorErrorCode.navigationTimeout,
        `Navigation timed out for ${safeUrlDescription(item.url)}.`,
        {},
        error,
      );
    }
    throw new CollectorError(
      CollectorErrorCode.navigationFailed,
      `Navigation failed for ${safeUrlDescription(item.url)}.`,
      {},
      error,
    );
  }

  if (response === null || !response.ok()) {
    throw new CollectorError(
      CollectorErrorCode.pageUnavailable,
      `The page was unavailable at ${safeUrlDescription(item.url)}.`,
      { status: response === null ? "none" : String(response.status()) },
    );
  }
  const contentType = response.headers()["content-type"];
  if (contentType !== undefined && !contentType.toLowerCase().includes("text/html")) {
    throw new CollectorError(
      CollectorErrorCode.pageUnavailable,
      `The page did not return HTML at ${safeUrlDescription(item.url)}.`,
      { contentType: contentType.split(";", 1)[0] ?? "unknown" },
    );
  }
  return response;
}

async function navigateWithRetries(
  page: Page,
  item: CrawlItem,
  options: ParsedCollectorOptions,
  getBlockedNavigation: () => string | undefined,
  resetBlockedNavigation: () => void,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.navigationRetries; attempt += 1) {
    resetBlockedNavigation();
    try {
      await navigateOnce(page, item, options, getBlockedNavigation);
      return;
    } catch (error) {
      lastError = error;
      if (error instanceof CollectorError && error.code === CollectorErrorCode.redirectDisallowed) throw error;
    }
  }
  if (lastError instanceof CollectorError) throw lastError;
  throw new CollectorError(CollectorErrorCode.navigationFailed, "Navigation failed after the configured retries.");
}

export async function collectWebsite(
  input: CollectorOptions,
  dependencies: CollectorDependencies = {},
): Promise<SiteSnapshot> {
  const options = parseCollectorOptions(input);
  const startUrl = canonicalizeHttpUrl(options.startUrl);
  if (startUrl === undefined) {
    throw new CollectorError(CollectorErrorCode.invalidStartUrl, "The start URL must be an absolute HTTP(S) URL.");
  }
  const allowedOrigins = normalizeAllowedOrigins(options);

  let browser;
  try {
    browser = await chromium.launch({ headless: options.headless });
  } catch (error) {
    throw new CollectorError(
      CollectorErrorCode.browserLaunchFailed,
      "Playwright could not launch Chromium.",
      {},
      error,
    );
  }

  try {
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    let blockedNavigation: string | undefined;
    let blockedUnsafeMethod: string | undefined;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const method = request.method().toUpperCase();
      if (!READ_ONLY_HTTP_METHODS.has(method)) {
        blockedUnsafeMethod = method;
        await route.abort("blockedbyclient");
        return;
      }
      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame() &&
        !isAllowedHttpUrl(request.url(), allowedOrigins)
      ) {
        blockedNavigation = request.url();
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });

    const queue: CrawlItem[] = [{ url: startUrl, depth: 0 }];
    const queued = new Set<string>([startUrl]);
    const visited = new Set<string>();
    const observedPages: ObservedPage[] = [];

    while (queue.length > 0 && observedPages.length < options.maxPages) {
      const item = queue.shift();
      if (item === undefined || visited.has(item.url)) continue;
      visited.add(item.url);

      await navigateWithRetries(
        page,
        item,
        options,
        () => blockedNavigation,
        () => {
          blockedNavigation = undefined;
          blockedUnsafeMethod = undefined;
        },
      );
      const observedUrl = canonicalizeHttpUrl(page.url());
      if (observedUrl === undefined || !isAllowedHttpUrl(observedUrl, allowedOrigins)) {
        throw new CollectorError(
          CollectorErrorCode.redirectDisallowed,
          `Navigation left the configured origins from ${safeUrlDescription(item.url)}.`,
        );
      }
      visited.add(observedUrl);
      let dom: DomObservation;
      try {
        dom = await observeDom(page);
      } catch (error) {
        throw new CollectorError(
          CollectorErrorCode.pageUnavailable,
          `The page DOM could not be observed at ${safeUrlDescription(observedUrl)}.`,
          {},
          error,
        );
      }
      if (blockedUnsafeMethod !== undefined) {
        throw new CollectorError(
          CollectorErrorCode.unsafeRequestBlocked,
          `The page attempted a non-read-only request while being observed at ${safeUrlDescription(observedUrl)}.`,
          { method: blockedUnsafeMethod },
        );
      }
      if (dom.blocks.length === 0 && dom.actions.length === 0) {
        throw new CollectorError(
          CollectorErrorCode.pageUnavailable,
          `The page exposed no supported visible content at ${safeUrlDescription(observedUrl)}.`,
        );
      }
      const observed: ObservedPage = { requestedUrl: item.url, observedUrl, depth: item.depth, dom };
      observedPages.push(observed);

      if (item.depth >= options.maxDepth) continue;
      for (const target of discoverCrawlTargets(observed, allowedOrigins)) {
        if (queued.has(target) || visited.has(target)) continue;
        queued.add(target);
        queue.push({ url: target, depth: item.depth + 1 });
      }
    }

    const now = dependencies.now ?? (() => new Date());
    return buildSiteSnapshot(observedPages, options, now().toISOString());
  } finally {
    await browser.close();
  }
}
