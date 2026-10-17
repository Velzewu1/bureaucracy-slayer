import { chromium, type Page, type Response, type Route } from "playwright";

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
type NavigationInterception =
  | Readonly<{ kind: "blocked_redirect"; url: string }>
  | Readonly<{ kind: "follow_redirect"; url: string }>
  | Readonly<{ kind: "failed" | "timeout" }>
  | undefined;

const READ_ONLY_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 10;

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
  getNavigationInterception: () => NavigationInterception,
  resetNavigationInterception: () => void,
  getBlockedUnsafeMethod: () => string | undefined,
): Promise<Response> {
  let navigationUrl = item.url;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECT_HOPS; redirectCount += 1) {
    resetNavigationInterception();
    let response: Response | null;
    try {
      response = await page.goto(navigationUrl, {
        timeout: options.navigationTimeoutMs,
        waitUntil: "load",
      });
    } catch (error) {
      const interception = getNavigationInterception();
      if (interception?.kind === "blocked_redirect") {
        throw new CollectorError(
          CollectorErrorCode.redirectDisallowed,
          `Navigation was redirected outside the configured origins from ${safeUrlDescription(item.url)}.`,
          {},
          error,
        );
      }
      if (interception?.kind === "follow_redirect") {
        if (redirectCount >= MAX_REDIRECT_HOPS) {
          throw new CollectorError(
            CollectorErrorCode.navigationFailed,
            `Navigation exceeded the bounded redirect limit for ${safeUrlDescription(item.url)}.`,
            { maxRedirectHops: String(MAX_REDIRECT_HOPS) },
            error,
          );
        }
        navigationUrl = interception.url;
        continue;
      }
      const blockedUnsafeMethod = getBlockedUnsafeMethod();
      if (blockedUnsafeMethod !== undefined) {
        throw new CollectorError(
          CollectorErrorCode.unsafeRequestBlocked,
          `The page attempted a non-read-only request while navigating from ${safeUrlDescription(item.url)}.`,
          { method: blockedUnsafeMethod },
          error,
        );
      }
      if (interception?.kind === "timeout" || isTimeoutError(error)) {
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
  throw new CollectorError(
    CollectorErrorCode.navigationFailed,
    `Navigation exceeded the bounded redirect limit for ${safeUrlDescription(item.url)}.`,
    { maxRedirectHops: String(MAX_REDIRECT_HOPS) },
  );
}

async function navigateWithRetries(
  page: Page,
  item: CrawlItem,
  options: ParsedCollectorOptions,
  getNavigationInterception: () => NavigationInterception,
  resetNavigationInterception: () => void,
  getBlockedUnsafeMethod: () => string | undefined,
  resetAttemptState: () => void,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.navigationRetries; attempt += 1) {
    if (attempt > 0) {
      try {
        await page.goto("about:blank", { timeout: options.navigationTimeoutMs, waitUntil: "load" });
      } catch (error) {
        if (lastError instanceof CollectorError) throw lastError;
        throw new CollectorError(
          CollectorErrorCode.navigationFailed,
          "The browser could not reset navigation before a bounded retry.",
          {},
          error,
        );
      }
    }
    resetAttemptState();
    try {
      await navigateOnce(
        page,
        item,
        options,
        getNavigationInterception,
        resetNavigationInterception,
        getBlockedUnsafeMethod,
      );
      return;
    } catch (error) {
      lastError = error;
      if (
        error instanceof CollectorError &&
        (error.code === CollectorErrorCode.redirectDisallowed ||
          error.code === CollectorErrorCode.unsafeRequestBlocked)
      ) {
        throw error;
      }
    }
  }
  if (lastError instanceof CollectorError) throw lastError;
  throw new CollectorError(CollectorErrorCode.navigationFailed, "Navigation failed after the configured retries.");
}

async function routeDocumentRequest(
  route: Route,
  allowedOrigins: ReadonlySet<string>,
  navigationTimeoutMs: number,
  setNavigationInterception: (result: Exclude<NavigationInterception, undefined>) => void,
): Promise<void> {
  const requestUrl = route.request().url();
  if (!isAllowedHttpUrl(requestUrl, allowedOrigins)) {
    setNavigationInterception({ kind: "blocked_redirect", url: requestUrl });
    await route.abort("blockedbyclient");
    return;
  }

  let response;
  try {
    response = await route.fetch({ maxRedirects: 0, timeout: navigationTimeoutMs });
  } catch (error) {
    setNavigationInterception({ kind: isTimeoutError(error) ? "timeout" : "failed" });
    await route.abort(isTimeoutError(error) ? "timedout" : "failed");
    return;
  }

  const location = REDIRECT_STATUS_CODES.has(response.status()) ? response.headers()["location"] : undefined;
  if (location !== undefined) {
    const redirectUrl = canonicalizeHttpUrl(location, requestUrl);
    await response.dispose();
    if (redirectUrl === undefined || !isAllowedHttpUrl(redirectUrl, allowedOrigins)) {
      setNavigationInterception({ kind: "blocked_redirect", url: redirectUrl ?? requestUrl });
      await route.abort("blockedbyclient");
      return;
    }
    setNavigationInterception({ kind: "follow_redirect", url: redirectUrl });
    await route.abort("blockedbyclient");
    return;
  }

  try {
    await route.fulfill({ response });
  } catch (error) {
    setNavigationInterception({ kind: "failed" });
    await route.abort("failed");
  } finally {
    await response.dispose();
  }
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
    let blockedUnsafeMethod: string | undefined;
    let navigationInterception: NavigationInterception;
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
        request.frame() === page.mainFrame()
      ) {
        await routeDocumentRequest(
          route,
          allowedOrigins,
          options.navigationTimeoutMs,
          (result) => {
            navigationInterception = result;
          },
        );
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
        () => navigationInterception,
        () => {
          navigationInterception = undefined;
        },
        () => blockedUnsafeMethod,
        () => {
          blockedUnsafeMethod = undefined;
          navigationInterception = undefined;
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
