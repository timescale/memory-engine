/**
 * HTTP server powering `me serve`.
 *
 * Concerns:
 *
 * 1. Serve the embedded web UI (Vite build).
 * 2. Proxy `POST /rpc` to the space memory JSON-RPC endpoint, injecting the
 *    session token (Authorization: Bearer) and the active space (X-Me-Space).
 *    A browser-sent `X-Me-Space` overrides the bound space, so the web UI's
 *    space switcher works in local mode; the bound space is the fallback.
 * 3. Proxy `POST /api/v1/user/rpc` to the user JSON-RPC endpoint (whoami /
 *    space discovery), session-scoped and space-agnostic, so the web UI can
 *    show the signed-in account + a space picker in local mode.
 * 4. Answer `GET /api/serve-context` with the bound space, so the browser
 *    (which otherwise can't know it) can display + default to it.
 *
 * The proxy is intentionally transparent — it forwards request bodies
 * byte-for-byte and streams responses back, so any `memory.*` (and management)
 * RPC methods work without backend changes here.
 */
import { AS_AGENT_HEADER, SPACE_HEADER } from "@memory.build/protocol/headers";
import type { BearerSource } from "../session.ts";
import { resolveAssetResponse } from "./web-assets.ts";

export interface ServeOptions {
  /** Remote server URL (e.g., https://api.memory.build). */
  server: string;
  /**
   * Bearer source for proxied calls — the human's OAuth access token, resolved
   * per request and refreshed by expiry (and once reactively on a 401), so a
   * long-lived `me serve` survives token expiry. Forwarded as Authorization:
   * Bearer.
   */
  bearer: BearerSource;
  /** Active space slug. Forwarded as X-Me-Space. */
  space: string;
  /** Act-as-agent target. Forwarded as X-Me-As-Agent when set. */
  asAgent?: string;
  /** Hostname to bind (defaults to 127.0.0.1). */
  host: string;
  /** Port to bind. Use `findAvailablePort` first if you want auto-discovery. */
  port: number;
}

/**
 * Paths on the remote server. Kept as constants so tests can assert exact URLs.
 */
export const MEMORY_RPC_PATH = "/api/v1/memory/rpc";
export const USER_RPC_PATH = "/api/v1/user/rpc";

/** Local-only endpoint exposing the bound space to the browser. */
export const SERVE_CONTEXT_PATH = "/api/serve-context";

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

      // The bound space, so the web UI's account cluster can display + default
      // to it in local mode (the browser otherwise can't know it).
      if (req.method === "GET" && url.pathname === SERVE_CONTEXT_PATH) {
        return Response.json({ space: options.space });
      }

      // `/rpc` proxy — forwards memory JSON-RPC bodies to the configured engine,
      // injecting the bearer (the browser never sees it). The space comes from a
      // browser-sent X-Me-Space (the space switcher) and falls back to the bound
      // space.
      if (url.pathname === "/rpc") {
        if (req.method !== "POST") return methodNotAllowed("POST");
        const space = req.headers.get(SPACE_HEADER) || options.space;
        return proxyJsonRpc(req, options, MEMORY_RPC_PATH, space);
      }

      // User RPC (whoami / space discovery) — session-scoped, no space header.
      if (url.pathname === USER_RPC_PATH) {
        if (req.method !== "POST") return methodNotAllowed("POST");
        return proxyJsonRpc(req, options, USER_RPC_PATH);
      }

      // Everything else: serve embedded assets with SPA fallback to index.html.
      if (req.method !== "GET" && req.method !== "HEAD") {
        return methodNotAllowed("GET, HEAD");
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
function methodNotAllowed(allow: string): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: allow },
  });
}

/**
 * Forward a JSON-RPC request to one of the configured engine's endpoints
 * (`MEMORY_RPC_PATH` or `USER_RPC_PATH`).
 *
 * The body is buffered (not streamed) so that a 401 — an expired access token —
 * can be retried once with a freshly refreshed bearer. The engine's JSON-RPC
 * response is streamed back to the browser verbatim.
 *
 * `space` is sent as `X-Me-Space` for the memory endpoint; the user endpoint is
 * space-agnostic and passes `undefined`.
 *
 * Errors talking to the remote engine surface as a JSON-RPC-shaped 502 so
 * the web UI can render them through the same error path as normal RPC
 * failures.
 */
async function proxyJsonRpc(
  req: Request,
  options: ServeOptions,
  path: string,
  space?: string,
): Promise<Response> {
  const targetUrl = new URL(path, options.server).toString();
  const contentType = req.headers.get("Content-Type");
  // Buffer the body so a 401 refresh can replay it (JSON-RPC bodies are small).
  const body = await req.arrayBuffer();

  // Rebuild the outgoing headers: drop hop-by-hop / host headers, keep
  // Content-Type (the body needs it), and set our own Authorization + space.
  const send = (token: string | undefined): Promise<Response> => {
    const outHeaders = new Headers();
    if (contentType) outHeaders.set("Content-Type", contentType);
    if (token) outHeaders.set("Authorization", `Bearer ${token}`);
    if (space) outHeaders.set(SPACE_HEADER, space);
    if (options.asAgent) outHeaders.set(AS_AGENT_HEADER, options.asAgent);
    outHeaders.set("Accept", "application/json");
    return fetch(targetUrl, { method: "POST", headers: outHeaders, body });
  };

  try {
    let token = await options.bearer.getToken();
    let upstream = await send(token);

    // Reactive refresh: one shot at a fresh token if the access token expired.
    if (upstream.status === 401) {
      const fresh = await options.bearer.onUnauthorized();
      if (fresh && fresh !== token) {
        token = fresh;
        upstream = await send(token);
      }
    }

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
    console.error(`[me serve] proxy failure for ${path}: ${message}`);
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
