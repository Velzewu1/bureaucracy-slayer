import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { SiteSnapshotSchema } from "../../src/contracts/index.js";
import { collectWebsite } from "../../src/collector/index.js";
import { hashPageSnapshotContent, hashSiteSnapshotContent } from "../../src/shared/index.js";

type TestSite = Readonly<{
  origin: string;
  requests: readonly string[];
  close: () => Promise<void>;
}>;

const openServers: Server[] = [];

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><head><title>Collector fixture</title></head><body>${body}</body></html>`);
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse, origin: string) => void,
): Promise<TestSite> {
  const requests: string[] = [];
  let origin = "";
  const server = createServer((request, response) => {
    requests.push(`${request.method ?? "UNKNOWN"} ${request.url ?? "/"}`);
    handler(request, response, origin);
  });
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP test server address");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

afterEach(async () => {
  const servers = openServers.splice(0);
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        }),
    ),
  );
});

describe("bounded Playwright collection", () => {
  it("collects real pages, policy text, links, buttons, and controls without interacting", async () => {
    const external = await startServer((_request, response) => {
      html(response, "<h1>External content must not be visited</h1>");
    });
    const local = await startServer((request, response) => {
      if (request.method === "POST") {
        response.writeHead(500);
        response.end("The collector must never submit this form");
        return;
      }
      if (request.url === "/policy") {
        html(
          response,
          '<main><article><h1>Transfer policy</h1><p>Scheduled transfers may be canceled before processing begins.</p><a href="/deep">Recovery policy</a></article></main>',
        );
        return;
      }
      if (request.url === "/deep") {
        html(response, "<main><h1>Recovery</h1><p>Completed transfers may be reviewed.</p></main>");
        return;
      }
      html(
        response,
        `<main>
          <h1>Transfer center</h1>
          <p>Review the policy before choosing an action.</p>
          <a href="/policy#scheduled">Read transfer policy</a>
          <a href="${external.origin}/leave">External partner</a>
          <button type="button" data-testid="cancel-transfer">Cancel transfer</button>
          <button type="button" disabled>Unavailable action</button>
          <form action="/mutate" method="post">
            <label for="reason">Reason</label><input id="reason" name="reason" value="private input value">
            <button type="submit">Submit cancellation</button>
          </form>
          <input type="password" aria-label="Password" value="must-not-be-collected">
        </main>`,
      );
    });

    const snapshot = await collectWebsite(
      {
        startUrl: `${local.origin}/`,
        maxPages: 5,
        maxDepth: 1,
        navigationTimeoutMs: 5_000,
      },
      { now: () => new Date("2026-10-16T18:00:00.000Z") },
    );

    expect(SiteSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.pages).toHaveLength(2);
    expect(snapshot.pages.every((page) => page.contentHash === hashPageSnapshotContent(page))).toBe(true);
    expect(snapshot.contentHash).toBe(hashSiteSnapshotContent(snapshot));
    expect(snapshot.pages.flatMap((page) => page.blocks.map((block) => block.text))).toContain(
      "Scheduled transfers may be canceled before processing begins.",
    );
    expect(snapshot.pages.flatMap((page) => page.actions.map((action) => action.label))).toEqual(
      expect.arrayContaining([
        "Read transfer policy",
        "External partner",
        "Cancel transfer",
        "Unavailable action",
        "Reason",
        "Submit cancellation",
      ]),
    );
    expect(snapshot.pages.flatMap((page) => page.actions).find((action) => action.label === "Unavailable action")).toMatchObject({
      visible: true,
      enabled: false,
    });
    expect(snapshot.pages.flatMap((page) => page.actions).some((action) => action.label === "Password")).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain("private input value");
    expect(JSON.stringify(snapshot)).not.toContain("must-not-be-collected");
    expect(local.requests).not.toContain("GET /deep");
    expect(local.requests).not.toContain("POST /mutate");
    expect(external.requests).toEqual([]);
  });

  it("enforces the page limit and preserves stable bindings on an unchanged recapture", async () => {
    const local = await startServer((request, response) => {
      if (request.url === "/second") {
        html(response, '<main><h1>Second</h1><p>Second page policy.</p><a href="/third">Third</a></main>');
        return;
      }
      if (request.url === "/third") {
        html(response, "<main><h1>Third</h1><p>Third page policy.</p></main>");
        return;
      }
      html(response, '<main><h1>First</h1><p>First page policy.</p><a href="/second">Second</a></main>');
    });
    const collectorOptions = { startUrl: local.origin, maxPages: 2, maxDepth: 5 };

    const first = await collectWebsite(collectorOptions, {
      now: () => new Date("2026-10-16T18:00:00.000Z"),
    });
    const second = await collectWebsite(collectorOptions, {
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    });

    expect(first.pages).toHaveLength(2);
    expect(first.id).toBe(second.id);
    expect(first.contentHash).toBe(second.contentHash);
    expect(local.requests).not.toContain("GET /third");
  });

  it("fails closed when a redirect leaves the allowed origin", async () => {
    const external = await startServer((_request, response) => {
      html(response, "<main><p>External destination</p></main>");
    });
    const local = await startServer((_request, response) => {
      response.writeHead(302, { location: `${external.origin}/outside` });
      response.end();
    });

    await expect(collectWebsite({ startUrl: local.origin, navigationRetries: 1 })).rejects.toMatchObject({
      code: "REDIRECT_DISALLOWED",
    });
    expect(local.requests).toEqual(["GET /"]);
    expect(external.requests).toEqual([]);
  });

  it("blocks an external destination after following only the allowed portion of a redirect chain", async () => {
    const external = await startServer((_request, response) => {
      html(response, "<main><p>External destination</p></main>");
    });
    const local = await startServer((request, response, origin) => {
      if (request.url === "/second") {
        response.writeHead(302, { location: `${external.origin}/outside` });
        response.end();
        return;
      }
      response.writeHead(302, { location: `${origin}/second` });
      response.end();
    });

    await expect(
      collectWebsite({ startUrl: `${local.origin}/first`, navigationRetries: 1 }),
    ).rejects.toMatchObject({
      code: "REDIRECT_DISALLOWED",
    });
    expect(local.requests).toEqual(["GET /first", "GET /second"]);
    expect(external.requests).toEqual([]);
  });

  it("reports unavailable pages instead of returning a fabricated snapshot", async () => {
    const local = await startServer((_request, response) => {
      response.writeHead(503, { "content-type": "text/html" });
      response.end("<main><p>Unavailable</p></main>");
    });

    await expect(collectWebsite({ startUrl: local.origin })).rejects.toMatchObject({
      code: "PAGE_UNAVAILABLE",
    });
  });

  it("reports bounded navigation timeouts and performs at most one configured retry", async () => {
    const local = await startServer(() => {
      // Intentionally leave the response open so Playwright's navigation timer is authoritative.
    });

    await expect(
      collectWebsite({ startUrl: local.origin, navigationTimeoutMs: 100, navigationRetries: 1 }),
    ).rejects.toMatchObject({ code: "NAVIGATION_TIMEOUT" });
    expect(local.requests).toHaveLength(2);
  });

  it("blocks page-script mutation requests during read-only discovery", async () => {
    const local = await startServer((_request, response) => {
      html(
        response,
        '<main><h1>Unsafe page</h1><p>Visible policy text.</p><script>fetch("/mutate", { method: "POST" })</script></main>',
      );
    });

    await expect(collectWebsite({ startUrl: local.origin, navigationRetries: 1 })).rejects.toMatchObject({
      code: "UNSAFE_REQUEST_BLOCKED",
    });
    expect(local.requests).toEqual(["GET /"]);
  });
});

const portalUrl = process.env.COLLECTOR_TEST_URL;

it.runIf(portalUrl !== undefined)("captures the configured unmodified mock portal", async () => {
  if (portalUrl === undefined) throw new Error("COLLECTOR_TEST_URL was not configured");
  const snapshot = await collectWebsite({
    startUrl: portalUrl,
    maxPages: 12,
    maxDepth: 3,
    navigationTimeoutMs: 10_000,
  });
  const visibleText = snapshot.pages.flatMap((page) => page.blocks.map((block) => block.text)).join(" ").toLowerCase();
  const actionLabels = snapshot.pages.flatMap((page) => page.actions.map((action) => action.label.toLowerCase()));

  expect(SiteSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  expect(visibleText).toContain("transfer");
  expect(visibleText).toContain("cancel");
  expect(visibleText).toContain("recovery");
  expect(actionLabels.length).toBeGreaterThan(0);
});
