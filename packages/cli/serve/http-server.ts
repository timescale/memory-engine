/**
 * HTTP server powering `me serve`.
 *
 * Two concerns:
 *
 * 1. Serve the embedded web UI (Vite build).
 * 2. Proxy `POST /rpc` to the space memory JSON-RPC endpoint, injecting the
 *    session token (Authorization: Bearer) and the active space (X-Me-Space).
 *
 * The proxy is intentionally transparent — it forwards request bodies
 * byte-for-byte and streams responses back, so any `memory.*` (and management)
 * RPC methods work without backend changes here.
 */
import { SPACE_HEADER } from "@memory.build/protocol/headers";
import { resolveAssetResponse } from "./web-assets.ts";

export interface ServeOptions {
  /** Remote server URL (e.g., https://api.memory.build). */
  server: string;
  /** Session token. Forwarded as Authorization: Bearer. */
  token: string;
  /** Active space slug. Forwarded as X-Me-Space. */
  space: string;
  /** Hostname to bind (defaults to 127.0.0.1). */
  host: string;
  /** Port to bind. Use `findAvailablePort` first if you want auto-discovery. */
  port: number;
}

/**
 * Path on the remote server where the space memory JSON-RPC endpoint lives.
 * Kept as a constant so tests can assert the exact URL.
 */
export const MEMORY_RPC_PATH = "/api/v1/memory/rpc";

export interface RunningServer {
  /** The URL the server is listening on (e.g., http://127.0.0.1:3000). */
  url: string;
  /** The underlying Bun server (call .stop() to shut down). */
  server: ReturnType<typeof Bun.serve>;
}

/**
 * Start the HTTP server. Binds to `options.host:options.port` — caller is
 * responsible for port discovery via {@link findAvailablePort} when desired.
 *
 * Throws if the port cannot be bound (e.g., EADDRINUSE).
 */
export function startHttpServer(options: ServeOptions): RunningServer {
  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    development: false,

    fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/healthz") {
        return Response.json({ ok: true });
      }

      // `/rpc` proxy — forwards JSON-RPC bodies to the configured engine,
      // injecting the stored API key. The browser never sees the key.
      if (url.pathname === "/rpc") {
        if (req.method !== "POST") {
          return new Response("Method Not Allowed", {
            status: 405,
            headers: { Allow: "POST" },
          });
        }
        return proxyRpc(req, options);
      }

      // Everything else: serve embedded assets with SPA fallback to index.html.
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      }
      return resolveAssetResponse(url.pathname);
    },

    error(err) {
      console.error("[me serve] request error:", err);
      return new Response("Internal server error", { status: 500 });
    },
  });

  return {
    url: `http://${options.host}:${server.port}`,
    server,
  };
}

/**
 * Try to bind successive ports starting at `startPort` until one succeeds
 * or `maxAttempts` is exhausted.
 *
 * Returns the first available port. Throws if none of the attempted ports
 * were available.
 *
 * Strategy: briefly bind with `Bun.serve` (no handler work) and immediately
 * stop. Binding is the only reliable "is it free?" check on most platforms.
 */
/**
 * Forward a `/rpc` request to the configured engine's JSON-RPC endpoint.
 *
 * The request body is streamed through unchanged; we only add/override the
 * Authorization header. The engine's JSON-RPC response is streamed back to
 * the browser verbatim.
 *
 * Errors talking to the remote engine surface as a JSON-RPC-shaped 502 so
 * the web UI can render them through the same error path as normal RPC
 * failures.
 */
async function proxyRpc(
  req: Request,
  options: ServeOptions,
): Promise<Response> {
  const targetUrl = new URL(MEMORY_RPC_PATH, options.server).toString();

  // Rebuild the outgoing headers: drop hop-by-hop / host headers, keep
  // Content-Type (the body needs it), and set our own Authorization + space.
  const outHeaders = new Headers();
  const contentType = req.headers.get("Content-Type");
  if (contentType) outHeaders.set("Content-Type", contentType);
  outHeaders.set("Authorization", `Bearer ${options.token}`);
  outHeaders.set(SPACE_HEADER, options.space);
  outHeaders.set("Accept", "application/json");

  try {
    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers: outHeaders,
      body: req.body,
      // Streaming request bodies require this hint per the Fetch spec.
      duplex: "half",
    });

    // Pass the upstream response through. We deliberately preserve the
    // upstream Content-Type and status so JSON-RPC error envelopes reach
    // the browser intact.
    const respHeaders = new Headers();
    const respType = upstream.headers.get("Content-Type");
    if (respType) respHeaders.set("Content-Type", respType);

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[me serve] /rpc proxy failure: ${message}`);
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message: `Proxy request to ${targetUrl} failed: ${message}`,
        },
      },
      { status: 502 },
    );
  }
}

export async function findAvailablePort(
  host: string,
  startPort: number,
  maxAttempts = 20,
): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    const probe = await tryBind(host, port);
    if (probe) return port;
  }
  throw new Error(
    `No available port found in range ${startPort}..${startPort + maxAttempts - 1}`,
  );
}

async function tryBind(host: string, port: number): Promise<boolean> {
  try {
    const server = Bun.serve({
      hostname: host,
      port,
      fetch: () => new Response("probe"),
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}
