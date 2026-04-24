import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite config for the Memory Engine web UI.
 *
 * - Build output lands in `dist/` and is embedded into the `me` binary by
 *   the CLI build.
 * - Dev server proxies `/rpc` to the locally-running `me serve` (port 3000
 *   by default) so the dev experience matches production.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@memory.build/client": fileURLToPath(
        new URL("../client/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/rpc": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/healthz": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
