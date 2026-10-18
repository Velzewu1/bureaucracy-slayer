import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

import { buildFixtureEnvelopes } from "./fixtures.js";
import { renderFixtureModule } from "./render.js";

/**
 * `npm run build:extension`
 *   1. regenerates src/generated/fixtureEnvelopes.ts from the deterministic pipeline (offline, no API);
 *   2. bundles background/content/sidepanel as self-contained IIFE scripts into extension/dist.
 * Use `--fixtures-only` to only regenerate the fixture module.
 */

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(here, "..");
const dist = resolve(extensionRoot, "dist");

async function main(): Promise<void> {
  const fixtures = await buildFixtureEnvelopes();
  mkdirSync(resolve(extensionRoot, "src/generated"), { recursive: true });
  writeFileSync(resolve(extensionRoot, "src/generated/fixtureEnvelopes.ts"), renderFixtureModule(fixtures));
  if (process.argv.includes("--fixtures-only")) return;

  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  for (const [entry, name] of [
    ["src/background.ts", "background"],
    ["src/content.ts", "content"],
    ["src/sidepanel.ts", "sidepanel"],
  ] as const) {
    await build({
      configFile: false,
      logLevel: "warn",
      root: extensionRoot,
      build: {
        outDir: dist,
        emptyOutDir: false,
        minify: false,
        sourcemap: false,
        target: "chrome120",
        lib: { entry: resolve(extensionRoot, entry), name: `slayer_${name}`, formats: ["iife"], fileName: () => `${name}.js` },
      },
    });
  }
  for (const file of ["manifest.json", "sidepanel.html", "sidepanel.css"]) {
    copyFileSync(resolve(extensionRoot, file), resolve(dist, file));
  }
}

await main();
