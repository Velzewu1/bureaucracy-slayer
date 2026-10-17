import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./src/ui", import.meta.url)),
  resolve: {
    alias: {
      "node:crypto": fileURLToPath(new URL("./src/ui/shims/nodeCrypto.ts", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/ui", import.meta.url)),
    emptyOutDir: true,
  },
});
