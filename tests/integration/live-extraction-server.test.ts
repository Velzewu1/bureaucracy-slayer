import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LIVE_EXTRACTION_MAX_REQUEST_BODY_BYTES,
  LiveExtractionErrorResponseSchema,
  LiveExtractionJobStatusSchema,
  LiveExtractionStartResponseSchema,
} from "../../src/orchestration/live-extraction-contract.js";
import {
  LiveExtractionJobManager,
  type LiveExtractionJobClock,
} from "../../src/orchestration/live-extraction-job-manager.js";
import { LIVE_EXTRACTION_UI_ORIGIN } from "../../src/orchestration/live-extraction-pipeline.js";
import {
  createLiveExtractionServer,
  listenLiveExtractionServer,
} from "../../src/server/live-extraction-server.js";
import {
  deferred,
  flushMicrotasks,
  liveExtractionArtifact,
} from "../live-extraction-test-helpers.js";

const servers: ReturnType<typeof createLiveExtractionServer>[] = [];

class ManualJobClock implements LiveExtractionJobClock {
  readonly #timers = new Map<
    ReturnType<typeof setTimeout>,
    Readonly<{ atMs: number; callback: () => void }>
  >();
  #nowMs = Date.parse("2026-10-17T12:00:00.000Z");

  now(): Date {
    return new Date(this.#nowMs);
  }

  setTimeout(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> {
    const handle = setTimeout(() => undefined, 2_147_483_647);
    handle.unref();
    this.#timers.set(handle, { atMs: this.#nowMs + delayMs, callback });
    return handle;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
    this.#timers.delete(handle);
  }

  advanceBy(delayMs: number): void {
    this.#nowMs += delayMs;
    let due = [...this.#timers.entries()].filter(([, timer]) => timer.atMs <= this.#nowMs);
    while (due.length > 0) {
      for (const [handle, timer] of due) {
        this.clearTimeout(handle);
        timer.callback();
      }
      due = [...this.#timers.entries()].filter(([, timer]) => timer.atMs <= this.#nowMs);
    }
  }
}

async function closeServer(server: ReturnType<typeof createLiveExtractionServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

async function startServer(manager: LiveExtractionJobManager): Promise<{
  server: ReturnType<typeof createLiveExtractionServer>;
  baseUrl: string;
  address: AddressInfo;
}> {
  const server = createLiveExtractionServer(manager);
  servers.push(server);
  await listenLiveExtractionServer(server, 0);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the live extraction test server to use a TCP address.");
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    address,
  };
}

function startBody(requestId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    action: "start_live_extraction",
    requestId,
  });
}

function apiFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      Origin: LIVE_EXTRACTION_UI_ORIGIN,
      ...init.headers,
    },
  });
}

describe("live extraction loopback API", () => {
  it("binds to IPv4 loopback and implements valid idempotent POST and GET", async () => {
    const runner = vi.fn(() => Promise.resolve(liveExtractionArtifact()));
    const manager = new LiveExtractionJobManager({ runner });
    const { baseUrl, address } = await startServer(manager);
    expect(address.address).toBe("127.0.0.1");

    const firstResponse = await apiFetch(`${baseUrl}/api/live-extraction/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: startBody("request_11111111111111111111111111111111"),
    });
    expect(firstResponse.status).toBe(202);
    expect(firstResponse.headers.get("cache-control")).toBe("no-store");
    expect(firstResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(firstResponse.headers.get("access-control-allow-origin")).toBeNull();
    const started = LiveExtractionStartResponseSchema.parse(await firstResponse.json());
    expect(firstResponse.headers.get("location")).toBe(started.statusUrl);
    expect(firstResponse.headers.get("retry-after")).toBe("1");

    const duplicateResponse = await apiFetch(`${baseUrl}/api/live-extraction/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: startBody("request_11111111111111111111111111111111"),
    });
    const duplicate = LiveExtractionStartResponseSchema.parse(
      await duplicateResponse.json(),
    );
    expect(duplicateResponse.status).toBe(202);
    expect(duplicate.jobId).toBe(started.jobId);

    await flushMicrotasks();
    const statusResponse = await fetch(`${baseUrl}${started.statusUrl}`, {
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(statusResponse.status).toBe(200);
    const status = LiveExtractionJobStatusSchema.parse(await statusResponse.json());
    expect(status).toMatchObject({
      jobId: started.jobId,
      state: "succeeded",
      result: { evidence: { status: "degraded" } },
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("rejects a different request while the physical worker is occupied", async () => {
    const pending = deferred<ReturnType<typeof liveExtractionArtifact>>();
    const runner = vi.fn(() => pending.promise);
    const manager = new LiveExtractionJobManager({ runner });
    const { baseUrl } = await startServer(manager);

    const first = await apiFetch(`${baseUrl}/api/live-extraction/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: startBody("request_11111111111111111111111111111111"),
    });
    expect(first.status).toBe(202);
    const competing = await apiFetch(`${baseUrl}/api/live-extraction/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: startBody("request_22222222222222222222222222222222"),
    });
    expect(competing.status).toBe(409);
    expect(LiveExtractionErrorResponseSchema.parse(await competing.json())).toMatchObject({
      error: { code: "JOB_ALREADY_RUNNING" },
    });

    pending.resolve(liveExtractionArtifact());
    await flushMicrotasks();
  });

  it.each([
    ["malformed JSON", "{", 400, "REQUEST_INVALID", "application/json"],
    [
      "strict-schema violation",
      JSON.stringify({
        schemaVersion: 1,
        action: "start_live_extraction",
        requestId: "request_11111111111111111111111111111111",
        portalUrl: "https://attacker.example/",
      }),
      400,
      "REQUEST_INVALID",
      "application/json",
    ],
    [
      "unsupported action",
      JSON.stringify({
        schemaVersion: 1,
        action: "execute_browser_action",
        requestId: "request_11111111111111111111111111111111",
      }),
      400,
      "UNSUPPORTED_ACTION",
      "application/json",
    ],
    [
      "oversized body",
      `"${"x".repeat(LIVE_EXTRACTION_MAX_REQUEST_BODY_BYTES + 1)}"`,
      413,
      "REQUEST_TOO_LARGE",
      "application/json",
    ],
    [
      "wrong content type",
      startBody("request_11111111111111111111111111111111"),
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "text/plain",
    ],
  ])("rejects %s", async (_label, body, status, code, contentType) => {
    const manager = new LiveExtractionJobManager({
      runner: () => Promise.resolve(liveExtractionArtifact()),
    });
    const { baseUrl } = await startServer(manager);
    const response = await apiFetch(`${baseUrl}/api/live-extraction/jobs`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    });

    expect(response.status).toBe(status);
    expect(LiveExtractionErrorResponseSchema.parse(await response.json())).toMatchObject({
      error: { code },
    });
  });

  it("rejects missing and non-exact origins without wildcard CORS", async () => {
    const manager = new LiveExtractionJobManager({
      runner: () => Promise.resolve(liveExtractionArtifact()),
    });
    const { baseUrl } = await startServer(manager);
    for (const origin of [undefined, "http://localhost:5173", "https://attacker.example"]) {
      const response = await fetch(`${baseUrl}/api/live-extraction/jobs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(origin === undefined ? {} : { Origin: origin }),
        },
        body: startBody("request_11111111111111111111111111111111"),
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(LiveExtractionErrorResponseSchema.parse(await response.json())).toMatchObject({
        error: { code: "REQUEST_INVALID" },
      });
    }

    const invalidPollingOrigin = await fetch(
      `${baseUrl}/api/live-extraction/jobs/job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
      { headers: { Origin: "https://attacker.example" } },
    );
    expect(invalidPollingOrigin.status).toBe(400);
    const unverifiablePollingOrigin = await fetch(
      `${baseUrl}/api/live-extraction/jobs/job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    );
    expect(unverifiablePollingOrigin.status).toBe(400);
  });

  it("has no browser-action endpoint and returns typed method and ID errors", async () => {
    const manager = new LiveExtractionJobManager({
      runner: () => Promise.resolve(liveExtractionArtifact()),
    });
    const { baseUrl } = await startServer(manager);

    const execution = await apiFetch(`${baseUrl}/api/actions/action_cancel01/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(execution.status).toBe(404);

    const method = await apiFetch(`${baseUrl}/api/live-extraction/jobs`);
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("POST");
    expect(LiveExtractionErrorResponseSchema.parse(await method.json())).toMatchObject({
      error: { code: "UNSUPPORTED_ACTION" },
    });

    const invalidId = await apiFetch(`${baseUrl}/api/live-extraction/jobs/not-a-job`);
    expect(invalidId.status).toBe(400);
    expect(LiveExtractionErrorResponseSchema.parse(await invalidId.json())).toMatchObject({
      error: { code: "REQUEST_INVALID" },
    });
    const missing = await apiFetch(
      `${baseUrl}/api/live-extraction/jobs/job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    );
    expect(missing.status).toBe(404);
  });

  it("keeps the physical worker occupied after an HTTP-visible timeout and discards its late result", async () => {
    const clock = new ManualJobClock();
    const pending = deferred<ReturnType<typeof liveExtractionArtifact>>();
    const runner = vi
      .fn<() => Promise<ReturnType<typeof liveExtractionArtifact>>>()
      .mockImplementationOnce(() => pending.promise)
      .mockImplementationOnce(() => Promise.resolve(liveExtractionArtifact()));
    const manager = new LiveExtractionJobManager({
      runner,
      clock,
      timeoutMs: 1_000,
    });
    const { baseUrl } = await startServer(manager);

    const startResponse = await apiFetch(`${baseUrl}/api/live-extraction/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: startBody("request_11111111111111111111111111111111"),
    });
    const started = LiveExtractionStartResponseSchema.parse(await startResponse.json());
    await flushMicrotasks();

    clock.advanceBy(1_000);
    const timedOutResponse = await fetch(`${baseUrl}${started.statusUrl}`, {
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(timedOutResponse.status).toBe(200);
    expect(LiveExtractionJobStatusSchema.parse(await timedOutResponse.json())).toMatchObject({
      state: "failed",
      error: { code: "JOB_TIMED_OUT", stage: "timeout" },
    });

    const occupiedResponse = await apiFetch(`${baseUrl}/api/live-extraction/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: startBody("request_22222222222222222222222222222222"),
    });
    expect(occupiedResponse.status).toBe(409);
    expect(LiveExtractionErrorResponseSchema.parse(await occupiedResponse.json())).toMatchObject({
      error: { code: "JOB_ALREADY_RUNNING" },
    });

    pending.resolve(liveExtractionArtifact());
    await flushMicrotasks();
    const lateResultResponse = await fetch(`${baseUrl}${started.statusUrl}`, {
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(LiveExtractionJobStatusSchema.parse(await lateResultResponse.json())).toMatchObject({
      state: "failed",
      error: { code: "JOB_TIMED_OUT" },
    });

    const replacementResponse = await apiFetch(`${baseUrl}/api/live-extraction/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: startBody("request_22222222222222222222222222222222"),
    });
    expect(replacementResponse.status).toBe(202);
    await flushMicrotasks();
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("sanitizes unexpected failures before returning them to polling clients", async () => {
    const secrets = [
      "sk-ant-secret-value",
      "workspace-secret-value",
      "Authorization: Bearer hidden",
      "raw Claude prompt",
    ];
    const manager = new LiveExtractionJobManager({
      runner: () => Promise.reject(new Error(secrets.join(" | "))),
    });
    const { baseUrl } = await startServer(manager);
    const startResponse = await apiFetch(`${baseUrl}/api/live-extraction/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: startBody("request_11111111111111111111111111111111"),
    });
    const started = LiveExtractionStartResponseSchema.parse(await startResponse.json());
    await flushMicrotasks();

    const statusResponse = await fetch(`${baseUrl}${started.statusUrl}`, {
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    const responseText = await statusResponse.text();
    expect(statusResponse.status).toBe(200);
    expect(LiveExtractionJobStatusSchema.parse(JSON.parse(responseText))).toMatchObject({
      state: "failed",
      error: { code: "INTERNAL_ERROR", issueCodes: [] },
    });
    for (const secret of secrets) expect(responseText).not.toContain(secret);
    expect(responseText).not.toContain("stack");
  });

  it("returns 410 during the tombstone window and 404 after it expires", async () => {
    const clock = new ManualJobClock();
    const manager = new LiveExtractionJobManager({
      runner: () => Promise.resolve(liveExtractionArtifact()),
      clock,
      terminalRetentionMs: 1_000,
    });
    const { baseUrl } = await startServer(manager);
    const startResponse = await apiFetch(`${baseUrl}/api/live-extraction/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: startBody("request_11111111111111111111111111111111"),
    });
    const started = LiveExtractionStartResponseSchema.parse(await startResponse.json());
    await flushMicrotasks();

    clock.advanceBy(1_000);
    const expired = await fetch(`${baseUrl}${started.statusUrl}`, {
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(expired.status).toBe(410);
    expect(LiveExtractionErrorResponseSchema.parse(await expired.json())).toMatchObject({
      error: { code: "JOB_EXPIRED" },
    });

    clock.advanceBy(1_000);
    const missing = await fetch(`${baseUrl}${started.statusUrl}`, {
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(missing.status).toBe(404);
  });

  it("enforces terminal-result and tombstone bounds through the HTTP API", async () => {
    const runner = vi.fn(() => Promise.resolve(liveExtractionArtifact()));
    const manager = new LiveExtractionJobManager({
      runner,
      terminalResultLimit: 1,
      tombstoneLimit: 2,
    });
    const { baseUrl } = await startServer(manager);
    const requestIds = [
      "request_11111111111111111111111111111111",
      "request_22222222222222222222222222222222",
      "request_33333333333333333333333333333333",
      "request_44444444444444444444444444444444",
    ] as const;
    const starts: Array<ReturnType<typeof LiveExtractionStartResponseSchema.parse>> = [];

    for (const requestId of requestIds) {
      const response = await apiFetch(`${baseUrl}/api/live-extraction/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: startBody(requestId),
      });
      expect(response.status).toBe(202);
      starts.push(LiveExtractionStartResponseSchema.parse(await response.json()));
      await flushMicrotasks();
    }

    const expectedStatuses = [404, 410, 410, 200] as const;
    for (const [index, start] of starts.entries()) {
      const response = await fetch(`${baseUrl}${start.statusUrl}`, {
        headers: { "Sec-Fetch-Site": "same-origin" },
      });
      expect(response.status).toBe(expectedStatuses[index]);
    }

    const retainedTombstone = starts[1];
    if (retainedTombstone === undefined) throw new Error("Expected a retained tombstone fixture.");
    const duplicate = await apiFetch(`${baseUrl}/api/live-extraction/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: startBody(requestIds[1]),
    });
    expect(duplicate.status).toBe(202);
    expect(LiveExtractionStartResponseSchema.parse(await duplicate.json())).toMatchObject({
      jobId: retainedTombstone.jobId,
      state: "succeeded",
    });
    expect(runner).toHaveBeenCalledTimes(requestIds.length);
  });
});
