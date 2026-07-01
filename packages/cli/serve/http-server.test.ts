/**
 * Tests for the `me serve` HTTP server.
 *
 * These exercise the proxy and basic routing in-process against a mock
 * upstream — no network access required.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AS_AGENT_HEADER, SPACE_HEADER } from "@memory.build/protocol/headers";
import {
  findAvailablePort,
  MEMORY_RPC_PATH,
  type RunningServer,
  SERVE_CONTEXT_PATH,
  startHttpServer,
  USER_RPC_PATH,
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
      bearer: {
        getToken: async () => "sess-test-token",
        onUnauthorized: async () => undefined,
      },
      space: "abc123def456",
      asAgent: "serve-agent",
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
    expect(mock.lastRequest?.path).toBe(MEMORY_RPC_PATH);
    expect(mock.lastRequest?.body).toBe(rpcBody);
  });

  test("/rpc injects Authorization: Bearer <token> and X-Me-Space", async () => {
    await fetch(`${running.url}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(mock.lastRequest?.headers.authorization).toBe(
      "Bearer sess-test-token",
    );
    expect(mock.lastRequest?.headers[AS_AGENT_HEADER.toLowerCase()]).toBe(
      "serve-agent",
    );
    expect(mock.lastRequest?.headers[SPACE_HEADER.toLowerCase()]).toBe(
      "abc123def456",
    );
  });

  test("/rpc honors a browser-sent X-Me-Space, overriding the bound space", async () => {
    await fetch(`${running.url}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [SPACE_HEADER]: "zzz999" },
      body: "{}",
    });

    expect(mock.lastRequest?.headers[SPACE_HEADER.toLowerCase()]).toBe(
      "zzz999",
    );
  });

  test("serve-context returns the bound space", async () => {
    const res = await fetch(`${running.url}${SERVE_CONTEXT_PATH}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ space: "abc123def456" });
  });

  test("/api/v1/user/rpc proxies to the user RPC endpoint with no space header", async () => {
    const res = await fetch(`${running.url}${USER_RPC_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "whoami" }),
    });

    expect(res.status).toBe(200);
    expect(mock.lastRequest?.path).toBe(USER_RPC_PATH);
    expect(mock.lastRequest?.headers.authorization).toBe(
      "Bearer sess-test-token",
    );
    expect(mock.lastRequest?.headers[AS_AGENT_HEADER.toLowerCase()]).toBe(
      "serve-agent",
    );
    // User RPC is space-agnostic — no X-Me-Space should be forwarded.
    expect(
      mock.lastRequest?.headers[SPACE_HEADER.toLowerCase()],
    ).toBeUndefined();
  });

  test("/api/v1/user/rpc rejects non-POST with 405", async () => {
    const res = await fetch(`${running.url}${USER_RPC_PATH}`, {
      method: "GET",
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
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

describe("startHttpServer — 401 refresh", () => {
  test("a 401 refreshes the bearer and replays the request once", async () => {
    const upstreamPort = await findAvailablePort("127.0.0.1", 34400);
    const seen: string[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: upstreamPort,
      async fetch(req) {
        const auth = req.headers.get("authorization") ?? "";
        await req.text();
        seen.push(auth);
        // The stale token is rejected; the refreshed one succeeds.
        if (auth === "Bearer stale") {
          return Response.json(
            { error: { code: "UNAUTHORIZED", message: "expired" } },
            { status: 401 },
          );
        }
        return Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } });
      },
    });

    let refreshes = 0;
    const servePort = await findAvailablePort("127.0.0.1", 34500);
    const running = startHttpServer({
      server: `http://127.0.0.1:${upstreamPort}`,
      bearer: {
        getToken: async () => "stale",
        onUnauthorized: async () => {
          refreshes++;
          return "refreshed";
        },
      },
      space: "abc123def456",
      host: "127.0.0.1",
      port: servePort,
    });

    try {
      const res = await fetch(`${running.url}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ result: { ok: true } });
      expect(refreshes).toBe(1);
      expect(seen).toEqual(["Bearer stale", "Bearer refreshed"]);
    } finally {
      running.server.stop(true);
      upstream.stop(true);
    }
  });
});

describe("findAvailablePort", () => {
  test("returns the first unused port", async () => {
    const port = await findAvailablePort("127.0.0.1", 34300, 5);
    expect(port).toBeGreaterThanOrEqual(34300);
    expect(port).toBeLessThan(34305);
  });
});
