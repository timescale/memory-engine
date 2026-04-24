/**
 * Shared Memory Engine client for the web UI.
 *
 * The browser talks to the same-origin `/rpc` proxy exposed by `me serve`.
 * That proxy injects the stored API key, so this client intentionally has no
 * API key configured. Vite proxies `/rpc` to `me serve` during local dev.
 */
import { createClient } from "@memory.build/client";

export const memoryEngineClient = createClient({
  url: "",
  rpcPath: "/rpc",
  retries: 0,
});
