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
  path: "/api/v1/engine/rpc",
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
