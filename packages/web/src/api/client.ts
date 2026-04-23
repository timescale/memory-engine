/**
 * JSON-RPC 2.0 client for the Memory Engine web UI.
 *
 * Talks to `/rpc` on whatever host serves this page — either the
 * `me serve` backend (production) or Vite's dev server, which proxies
 * `/rpc` back to `me serve`.
 *
 * No auth is added here: the `me serve` proxy injects the stored API key.
 */

/**
 * Structured error thrown for JSON-RPC and HTTP failures. Carries the
 * numeric code when the server returned a JSON-RPC error envelope.
 */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

interface JsonRpcSuccess<T> {
  jsonrpc: "2.0";
  id: number | string | null;
  result: T;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

let requestId = 0;

/**
 * Any JSON-serializable object that can stand in as a JSON-RPC params bag.
 * Accepts typed interfaces transparently; we only care that the shape is
 * object-like so it can be stringified.
 */
export type RpcParams = object;

/**
 * Invoke an engine JSON-RPC method. Throws {@link RpcError} on failure.
 */
export async function rpc<T>(
  method: string,
  params: RpcParams = {},
): Promise<T> {
  const id = ++requestId;
  const res = await fetch("/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

  let body: JsonRpcResponse<T>;
  try {
    body = (await res.json()) as JsonRpcResponse<T>;
  } catch {
    throw new RpcError(
      `Non-JSON response from /rpc (HTTP ${res.status})`,
      -32700,
    );
  }

  if ("error" in body) {
    throw new RpcError(body.error.message, body.error.code, body.error.data);
  }

  if (!res.ok) {
    // JSON-RPC 2.0 should always wrap errors in the envelope, but defend
    // against proxies that don't.
    throw new RpcError(`HTTP ${res.status} from /rpc`, -32603);
  }

  return body.result;
}
