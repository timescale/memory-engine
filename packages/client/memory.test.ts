import { afterEach, expect, test } from "bun:test";
import { createMemoryClient } from "./memory.ts";
import { createUserClient } from "./user.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function captureFetch() {
  const captured = { headers: {} as Record<string, string>, url: "" };
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    captured.url = typeof input === "string" ? input : input.toString();
    const headers = init?.headers as Record<string, string> | undefined;
    if (headers) Object.assign(captured.headers, headers);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return captured;
}

test("memory client sends X-Me-Space and Bearer token to the memory endpoint", async () => {
  const captured = captureFetch();
  const client = createMemoryClient({
    url: "https://api.example.com",
    token: "sess-tok",
    space: "abc123def456",
    retries: 0,
  });

  await client.principal.list({});

  expect(captured.url).toBe("https://api.example.com/api/v1/memory/rpc");
  expect(captured.headers["X-Me-Space"]).toBe("abc123def456");
  expect(captured.headers.Authorization).toBe("Bearer sess-tok");
});

test("memory client setSpace updates the X-Me-Space header", async () => {
  const captured = captureFetch();
  const client = createMemoryClient({
    url: "https://api.example.com",
    token: "t",
    space: "aaaaaaaaaaaa",
    retries: 0,
  });
  client.setSpace("bbbbbbbbbbbb");

  await client.memory.tree();

  expect(captured.headers["X-Me-Space"]).toBe("bbbbbbbbbbbb");
});

test("user client targets the user endpoint with no X-Me-Space", async () => {
  const captured = captureFetch();
  const client = createUserClient({
    url: "https://api.example.com",
    token: "sess-tok",
    retries: 0,
  });

  await client.space.list();

  expect(captured.url).toBe("https://api.example.com/api/v1/user/rpc");
  expect(captured.headers["X-Me-Space"]).toBeUndefined();
  expect(captured.headers.Authorization).toBe("Bearer sess-tok");
});
