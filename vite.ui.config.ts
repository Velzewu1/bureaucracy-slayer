import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";

const LIVE_API_ORIGIN = "http://127.0.0.1:5190";

export default defineConfig({
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
