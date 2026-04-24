/**
 * Tests for the `me serve` HTTP server.
 *
 * These exercise the proxy and basic routing in-process against a mock
 * upstream — no network access required.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ENGINE_RPC_PATH,
  findAvailablePort,
  type RunningServer,
  startHttpServer,
} from "./http-server.ts";

interface MockUpstream {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  lastRequest: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
  } | null;
  /** Override for the next response. Defaults to a 200 JSON-RPC success. */
  nextResponse: Response | null;
}

/**
 * Spin up a minimal upstream that records the last request and lets each
 * test override the response it returns.
 */
function startMockUpstream(port: number): MockUpstream {
  const state: MockUpstream = {
    server: null as unknown as ReturnType<typeof Bun.serve>,
    url: `http://127.0.0.1:${port}`,
    lastRequest: null,
    nextResponse: null,
  };

  state.server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      state.lastRequest = {
        method: req.method,
        path: url.pathname,
        headers,
        body: await req.text(),
      };
      return (
        state.nextResponse ??
        Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } })
      );
    },
  });

  return state;
}

describe("startHttpServer", () => {
  let mock: MockUpstream;
  let running: RunningServer;

  beforeEach(async () => {
    const upstreamPort = await findAvailablePort("127.0.0.1", 34100);
    mock = startMockUpstream(upstreamPort);
    const servePort = await findAvailablePort("127.0.0.1", 34200);
    running = startHttpServer({
      server: mock.url,
      apiKey: "me.test.key",
      engineSlug: "test-engine",
      host: "127.0.0.1",
      port: servePort,
    });
  });

  afterEach(() => {
    running.server.stop(true);
    mock.server.stop(true);
  });

  test("healthz returns {ok:true}", async () => {
    const res = await fetch(`${running.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("unknown paths fall back to the HTML UI", async () => {
    const res = await fetch(`${running.url}/does-not-exist`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Memory Engine");
  });

  test("/rpc rejects non-POST with 405", async () => {
    const res = await fetch(`${running.url}/rpc`, { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  test("/rpc proxies the request body and response back", async () => {
    const rpcBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "memory.search",
      params: { semantic: "hello" },
    });

    const res = await fetch(`${running.url}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rpcBody,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: { ok: boolean };
    };
    expect(json.result.ok).toBe(true);

    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.path).toBe(ENGINE_RPC_PATH);
    expect(mock.lastRequest?.body).toBe(rpcBody);
  });

  test("/rpc injects Authorization: Bearer <apiKey>", async () => {
    await fetch(`${running.url}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(mock.lastRequest?.headers.authorization).toBe("Bearer me.test.key");
  });

  test("/rpc surfaces upstream status codes", async () => {
    mock.nextResponse = Response.json(
      {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "Method not found" },
      },
      { status: 404 },
    );

    const res = await fetch(`${running.url}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "bogus",
      }),
    });

    expect(res.status).toBe(404);
    const json = (await res.json()) as {
      error: { code: number; message: string };
    };
    expect(json.error.code).toBe(-32601);
  });

  test("/rpc returns a JSON-RPC-shaped 502 when upstream is unreachable", async () => {
    // Stop the upstream so the proxy fetch fails.
    mock.server.stop(true);

    const res = await fetch(`${running.url}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(502);
    const json = (await res.json()) as {
      jsonrpc: string;
      error: { code: number; message: string };
    };
    expect(json.jsonrpc).toBe("2.0");
    expect(json.error.code).toBe(-32000);
    expect(json.error.message).toContain("Proxy request");
  });
});

describe("findAvailablePort", () => {
  test("returns the first unused port", async () => {
    const port = await findAvailablePort("127.0.0.1", 34300, 5);
    expect(port).toBeGreaterThanOrEqual(34300);
    expect(port).toBeLessThan(34305);
  });
});
