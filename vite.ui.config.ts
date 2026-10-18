import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";

const DEFAULT_LIVE_API_ORIGIN = "http://127.0.0.1:5190";
const DEFAULT_EXECUTION_POLICY = "live";

export function resolveUiExecutionPolicy(
  value = process.env["BUREAUCRACY_SLAYER_EXECUTION_POLICY"],
): "live" | "offline_mock" | "recorded_replay" | "verified_fixture" {
  const candidate = value === undefined || value === "" ? DEFAULT_EXECUTION_POLICY : value;
  if (
    candidate !== "live" &&
    candidate !== "offline_mock" &&
    candidate !== "recorded_replay" &&
    candidate !== "verified_fixture"
  ) {
    throw new Error(
      "BUREAUCRACY_SLAYER_EXECUTION_POLICY must be live, offline_mock, recorded_replay, or verified_fixture.",
    );
  }
  return candidate;
}

export function resolveLiveApiOrigin(
  value = process.env["BUREAUCRACY_SLAYER_LIVE_API_ORIGIN"],
): string {
  const candidate = value === undefined || value === "" ? DEFAULT_LIVE_API_ORIGIN : value;
  const parsed = new URL(candidate);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "BUREAUCRACY_SLAYER_LIVE_API_ORIGIN must be a loopback HTTP origin such as http://127.0.0.1:5190.",
    );
  }
  return parsed.origin;
}

const LIVE_API_ORIGIN = resolveLiveApiOrigin();
const EXECUTION_POLICY = resolveUiExecutionPolicy();

export default defineConfig({
  define: {
    __BUREAUCRACY_SLAYER_EXECUTION_POLICY__: JSON.stringify(EXECUTION_POLICY),
  },
  root: fileURLToPath(new URL("./src/ui", import.meta.url)),
  resolve: {
    alias: {
      "node:crypto": fileURLToPath(new URL("./src/ui/shims/nodeCrypto.ts", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api/live-extraction": {
        target: LIVE_API_ORIGIN,
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api/live-extraction": {
        target: LIVE_API_ORIGIN,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/ui", import.meta.url)),
    emptyOutDir: true,
  },
});
