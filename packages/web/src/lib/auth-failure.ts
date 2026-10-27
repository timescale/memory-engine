import { isRpcError } from "@memory.build/client";

/**
 * True only for an authentication failure from the user or memory RPC. Other
 * failures (CSRF/403, 5xx, network) are not fixed by signing in, so callers
 * show an error/retry screen for those instead.
 *
 * The auth middleware's 401 is not a JSON-RPC envelope: its body is
 * `{"error":{"message":…,"code":"UNAUTHORIZED"}}`, so the transport surfaces
 * the string code on `RpcError.code`, not `data.code`. A handler-level
 * UNAUTHORIZED (a real JSON-RPC error) carries it in `data.code`. Check both.
 */
export function isAuthFailure(err: unknown): boolean {
  if (!isRpcError(err)) return false;
  return (
    String(err.code) === "UNAUTHORIZED" || err.data?.code === "UNAUTHORIZED"
  );
}
