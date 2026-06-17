/**
 * Memory Engine clients for the web UI.
 *
 * Two runtime modes (see `bootstrap.ts`):
 * - **local** (`me serve`): the browser talks to the same-origin `/rpc` proxy,
 *   which injects the session token (Authorization) and the active space
 *   (X-Me-Space). The client carries neither.
 * - **hosted** (API server, same-origin): auth is the httpOnly session cookie
 *   (auto-attached on same-origin requests), and the active space is chosen in
 *   the UI and applied via `memoryClient.setSpace`. The `userClient` (whoami /
 *   space.list / agents) is reachable only in hosted mode.
 *
 * The UI ships with the server it's served from, so there's no version skew to
 * guard — we don't send X-Client-Version.
 */
import { createMemoryClient, createUserClient } from "@memory.build/client";
import { HOSTED } from "./bootstrap.ts";

export const memoryClient = createMemoryClient(
  HOSTED
    ? { url: "", rpcPath: "/api/v1/memory/rpc", retries: 0 }
    : { url: "", rpcPath: "/rpc", retries: 0 },
);

/**
 * User RPC client (session-cookie auth, same-origin). Used by the hosted-mode
 * auth gate for whoami + space discovery. Created unconditionally but only
 * exercised in hosted mode (`me serve` doesn't proxy the user RPC).
 */
export const userClient = createUserClient({
  url: "",
  rpcPath: "/api/v1/user/rpc",
  retries: 0,
});
