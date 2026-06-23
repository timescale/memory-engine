import { afterEach, describe, expect, test } from "bun:test";
import { rpcCall, type TransportConfig } from "./transport.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function captureFetch(): {
  headers: Record<string, string>;
  body: string;
  url: string;
} & { setResponse: (status: number, body: unknown) => void } {
  const captured = { headers: {} as Record<string, string>, body: "", url: "" };
  let response: Response = new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    captured.url = typeof input === "string" ? input : input.toString();
    const headers = init?.headers as Record<string, string> | undefined;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        captured.headers[k] = v;
      }
    }
    captured.body = (init?.body as string) ?? "";
    return response;
  }) as typeof fetch;

  return Object.assign(captured, {
    setResponse(status: number, body: unknown) {
      response = new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
}

const baseConfig = {
  url: "https://api.example.com",
  path: "/api/v1/memory/rpc",
  timeout: 5_000,
  retries: 0,
} satisfies Omit<TransportConfig, "clientVersion" | "token">;

describe("rpcCall — X-Client-Version header", () => {
  test("sends X-Client-Version header when clientVersion is configured", async () => {
    const captured = captureFetch();

    await rpcCall<{ ok: boolean }>(
      { ...baseConfig, clientVersion: "0.2.0" },
      "ping",
      {},
    );

    expect(captured.headers["X-Client-Version"]).toBe("0.2.0");
  });

  test("omits X-Client-Version header when clientVersion is not set", async () => {
    const captured = captureFetch();

    await rpcCall<{ ok: boolean }>(baseConfig, "ping", {});

    expect(captured.headers["X-Client-Version"]).toBeUndefined();
  });

  test("sends X-Client-Version alongside Authorization", async () => {
    const captured = captureFetch();

    await rpcCall<{ ok: boolean }>(
      { ...baseConfig, clientVersion: "1.2.3", token: "secret" },
      "ping",
      {},
    );

    expect(captured.headers["X-Client-Version"]).toBe("1.2.3");
    expect(captured.headers.Authorization).toBe("Bearer secret");
  });
});

describe("rpcCall — token provider", () => {
  test("getToken supplies the bearer and overrides a static token", async () => {
    const captured = captureFetch();

    await rpcCall<{ ok: boolean }>(
      {
        ...baseConfig,
        token: "static-ignored",
        getToken: async () => "fresh-access-token",
      },
      "ping",
      {},
    );

    expect(captured.headers.Authorization).toBe("Bearer fresh-access-token");
  });

  test("a 401 triggers onUnauthorized and retries once with the new token", async () => {
    const authSeen: (string | null)[] = [];
    let calls = 0;
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls++;
      const headers = init?.headers as Record<string, string> | undefined;
      authSeen.push(headers?.Authorization ?? null);
      // First request is unauthorized; the post-refresh retry succeeds.
      const status = calls === 1 ? 401 : 200;
      return new Response(
        JSON.stringify(
          status === 401
            ? { error: { code: "UNAUTHORIZED", message: "expired" } }
            : { jsonrpc: "2.0", id: 1, result: { ok: true } },
        ),
        { status, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    let refreshes = 0;
    const result = await rpcCall<{ ok: boolean }>(
      {
        ...baseConfig,
        getToken: async () => "stale-token",
        onUnauthorized: async () => {
          refreshes++;
          return "refreshed-token";
        },
      },
      "ping",
      {},
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(refreshes).toBe(1);
    expect(authSeen).toEqual(["Bearer stale-token", "Bearer refreshed-token"]);
  });

  test("refresh is attempted at most once; a second 401 surfaces as an error", async () => {
    let calls = 0;
    globalThis.fetch = (async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      calls++;
      return new Response(
        JSON.stringify({ error: { code: "UNAUTHORIZED", message: "nope" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    let refreshes = 0;
    let error: unknown;
    try {
      await rpcCall<{ ok: boolean }>(
        {
          ...baseConfig,
          getToken: async () => "stale-token",
          onUnauthorized: async () => {
            refreshes++;
            return "still-bad-token";
          },
        },
        "ping",
        {},
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(refreshes).toBe(1); // one shot only
    expect(calls).toBe(2); // original + one refreshed retry
  });

  test("onUnauthorized returning undefined lets the 401 surface", async () => {
    let calls = 0;
    globalThis.fetch = (async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      calls++;
      return new Response(
        JSON.stringify({ error: { code: "UNAUTHORIZED", message: "nope" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    let error: unknown;
    try {
      await rpcCall<{ ok: boolean }>(
        {
          ...baseConfig,
          getToken: async () => "stale-token",
          onUnauthorized: async () => undefined,
        },
        "ping",
        {},
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(calls).toBe(1); // no retry when refresh yields nothing
  });
});

describe("rpcCall — retries", () => {
  test("per-call retry override suppresses configured retries", async () => {
    let calls = 0;
    globalThis.fetch = (async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      calls++;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    let error: unknown;
    try {
      await rpcCall<{ ok: boolean }>(
        { ...baseConfig, retries: 3 },
        "memory.deleteTree",
        {},
        { retries: 0 },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(calls).toBe(1);
  });
});
