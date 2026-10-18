import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { buildFixtureEnvelopes } from "../../extension/scripts/fixtures.js";
import { buildGoalCatalog } from "../../extension/scripts/goal-catalog.js";
import { renderFixtureModule } from "../../extension/scripts/render.js";

const root = resolve(import.meta.dirname, "../../extension");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const sources = readdirSync(resolve(root, "src"))
  .filter((name) => name.endsWith(".ts") && name !== "chrome.d.ts")
  .map((name) => ({ name, text: read(`src/${name}`) }));

describe("manifest", () => {
  const manifest = JSON.parse(read("manifest.json")) as Record<string, unknown>;

  it("requests only sidePanel and storage, and one loopback host", () => {
    expect(manifest["manifest_version"]).toBe(3);
    expect(manifest["permissions"]).toEqual(["sidePanel", "storage"]);
    expect(manifest["host_permissions"]).toEqual(["http://127.0.0.1:5180/*"]);
    expect(manifest["optional_permissions"]).toBeUndefined();
    expect(manifest["externally_connectable"]).toBeUndefined();
    expect(manifest["web_accessible_resources"]).toBeUndefined();
  });

  it("injects the content script only on the trusted origin", () => {
    const scripts = manifest["content_scripts"] as { matches: string[]; all_frames: boolean }[];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.matches).toEqual(["http://127.0.0.1:5180/*"]);
    expect(scripts[0]?.all_frames).toBe(false);
  });

  it("forbids remote code and network from extension pages", () => {
    const csp = (manifest["content_security_policy"] as { extension_pages: string }).extension_pages;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toMatch(/unsafe-eval|unsafe-inline|https?:/);
  });

  it("keeps the declared origin in sync with the code's trusted origin list", () => {
    expect(read("src/guidance.ts")).toContain('["http://127.0.0.1:5180"]');
  });
});

describe("source safety", () => {
  it("the content script never clicks, submits, focuses, types or dispatches events", () => {
    const content = sources.find((source) => source.name === "content.ts")?.text ?? "";
    for (const forbidden of [/\.click\s*\(/, /\.submit\s*\(/, /\.requestSubmit\s*\(/, /\.focus\s*\(/, /dispatchEvent/, /\.value\s*=/, /new (Mouse|Keyboard|Input)?Event/, /execCommand/]) {
      expect(content).not.toMatch(forbidden);
    }
  });

  it("no extension source uses network, eval, dynamic code, cookies, history or the Anthropic SDK", () => {
    for (const { name, text } of sources) {
      for (const forbidden of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /\beval\s*\(/, /new Function/, /innerHTML/, /chrome\.cookies/, /chrome\.history/, /chrome\.scripting/, /anthropic/i, /ANTHROPIC/, /sendBeacon/]) {
        expect(text, `${name} ${String(forbidden)}`).not.toMatch(forbidden);
      }
    }
  });

  it("only the background worker can navigate tabs", () => {
    for (const { name, text } of sources) {
      if (name === "background.ts") continue;
      expect(text, name).not.toMatch(/chrome\.tabs\.(update|create)/);
      expect(text, name).not.toMatch(/location\.(href|assign|replace)\s*[=(]/);
    }
  });

  it("the committed fixture module matches a fresh deterministic offline build", async () => {
    const fresh = renderFixtureModule(await buildFixtureEnvelopes(), await buildGoalCatalog());
    expect(read("src/generated/fixtureEnvelopes.ts")).toBe(fresh);
  });
});
