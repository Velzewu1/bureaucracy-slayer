import { describe, expect, it } from "vitest";

import { resolveMockApiPort } from "../../scripts/mock-live-extraction-server.js";
import { analysisProgressLabel } from "../../src/ui/App.js";
import {
  resolveLiveApiOrigin,
  resolveUiExecutionPolicy,
} from "../../vite.ui.config.js";

describe("offline demo startup configuration", () => {
  it("keeps the documented default ports", () => {
    expect(resolveMockApiPort("")).toBe(5_190);
    expect(resolveLiveApiOrigin("")).toBe("http://127.0.0.1:5190");
  });

  it("accepts isolated loopback ports for safe rehearsals", () => {
    expect(resolveMockApiPort("5191")).toBe(5_191);
    expect(resolveLiveApiOrigin("http://127.0.0.1:5191")).toBe(
      "http://127.0.0.1:5191",
    );
    expect(resolveUiExecutionPolicy("offline_mock")).toBe("offline_mock");
  });

  it("rejects invalid ports and non-loopback API origins", () => {
    expect(() => resolveMockApiPort("0")).toThrow(/decimal TCP port/u);
    expect(() => resolveMockApiPort("65536")).toThrow(/between 1 and 65535/u);
    expect(() => resolveLiveApiOrigin("https://127.0.0.1:5191")).toThrow(/loopback HTTP/u);
    expect(() => resolveLiveApiOrigin("http://example.com:5191")).toThrow(/loopback HTTP/u);
    expect(() => resolveLiveApiOrigin("http://127.0.0.1:5191/path")).toThrow(/loopback HTTP/u);
    expect(resolveUiExecutionPolicy("recorded_replay")).toBe("recorded_replay");
    expect(resolveUiExecutionPolicy("verified_fixture")).toBe("verified_fixture");
    expect(() => resolveUiExecutionPolicy("recorded")).toThrow(/offline_mock/u);
  });
});

describe("unified analysis progress labels", () => {
  it("uses one product label and keeps local replanning distinct", () => {
    expect(analysisProgressLabel("recorded_sonnet", "analyzing")).toBe(
      "Website analysis",
    );
    expect(analysisProgressLabel("verified_fixture", "analyzing")).toBe("Website analysis");
    expect(analysisProgressLabel("recorded_sonnet", "replanning")).toBe(
      "Deterministic replan",
    );
  });
});
