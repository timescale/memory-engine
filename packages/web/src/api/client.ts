/**
 * Shared Memory Engine client for the web UI.
 *
 * The browser talks to the same-origin `/rpc` proxy exposed by `me serve`.
 * That proxy injects the session token (Authorization) and the active space
 * (X-Me-Space), so this client carries neither. Vite proxies `/rpc` to
 * `me serve` during local dev.
 */
import { createMemoryClient } from "@memory.build/client";

export const memoryClient = createMemoryClient({
  url: "",
  rpcPath: "/rpc",
  retries: 0,
});
