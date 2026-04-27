import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function sourcePath(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

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
    alias: [
      // Vite does not use Bun's package export condition, so resolve
      // workspace packages to source instead of ignored/stale dist output.
      {
        find: /^@memory\.build\/client$/,
        replacement: sourcePath("../client/index.ts"),
      },
      {
        find: /^@memory\.build\/protocol$/,
        replacement: sourcePath("../protocol/index.ts"),
      },
      {
        find: /^@memory\.build\/protocol\/(accounts|engine)$/,
        replacement: sourcePath("../protocol/$1/index.ts"),
      },
      {
        find: /^@memory\.build\/protocol\/(.+)$/,
        replacement: sourcePath("../protocol/$1.ts"),
      },
    ],
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
