import { afterEach, expect, test } from "bun:test";
import { createMemoryClient } from "./memory.ts";
import { createUserClient } from "./user.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function captureFetch() {
  const captured = {
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    url: "",
  };
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    captured.url = typeof input === "string" ? input : input.toString();
    captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    if (headers) Object.assign(captured.headers, headers);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return captured;
}

function captureStatusFetch(statuses: number[]) {
  const captured = { calls: 0 };
  globalThis.fetch = (async (
    _input: string | URL | Request,
    _init?: RequestInit,
  ) => {
    const status =
      statuses[Math.min(captured.calls, statuses.length - 1)] ?? 200;
    captured.calls++;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return captured;
}

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  return undefined;
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

test("memory client sends X-Me-As-Agent when asAgent is set", async () => {
  const captured = captureFetch();
  const client = createMemoryClient({
    url: "https://api.example.com",
    token: "sess-tok",
    space: "abc123def456",
    asAgent: "my-agent",
    retries: 0,
  });

  await client.memory.tree();

  expect(captured.headers["X-Me-As-Agent"]).toBe("my-agent");
  expect(captured.headers["X-Me-Space"]).toBe("abc123def456");
});

test("memory client rejects unresolved .me asAgent sentinel", () => {
  expect(() =>
    createMemoryClient({
      url: "https://api.example.com",
      token: "sess-tok",
      space: "abc123def456",
      asAgent: ".me",
      retries: 0,
    }),
  ).toThrow(/resolved/);
});

test("memory client omits X-Me-As-Agent when asAgent is unset", async () => {
  const captured = captureFetch();
  const client = createMemoryClient({
    url: "https://api.example.com",
    token: "sess-tok",
    space: "abc123def456",
    retries: 0,
  });

  await client.memory.tree();

  expect(captured.headers["X-Me-As-Agent"]).toBeUndefined();
});

test("memory client setAsAgent sets then clears the X-Me-As-Agent header", async () => {
  const captured = captureFetch();
  const client = createMemoryClient({
    url: "https://api.example.com",
    token: "t",
    space: "aaaaaaaaaaaa",
    retries: 0,
  });

  client.setAsAgent("agent-x");
  await client.memory.tree();
  expect(captured.headers["X-Me-As-Agent"]).toBe("agent-x");
  // Space is preserved through the header merge.
  expect(captured.headers["X-Me-Space"]).toBe("aaaaaaaaaaaa");

  client.setAsAgent("");
  captured.headers = {};
  await client.memory.tree();
  expect(captured.headers["X-Me-As-Agent"]).toBeUndefined();
});

test("memory client setAsAgent rejects unresolved .me sentinel", () => {
  const client = createMemoryClient({
    url: "https://api.example.com",
    token: "t",
    space: "aaaaaaaaaaaa",
    retries: 0,
  });

  expect(() => client.setAsAgent(".me")).toThrow(/resolved/);
});

test("user client sends X-Me-As-Agent when asAgent is set (headers initialized from unset)", async () => {
  const captured = captureFetch();
  const client = createUserClient({
    url: "https://api.example.com",
    token: "sess-tok",
    asAgent: "my-agent",
    retries: 0,
  });

  await client.whoami();

  expect(captured.headers["X-Me-As-Agent"]).toBe("my-agent");
});

test("user client rejects unresolved .me asAgent sentinel", () => {
  expect(() =>
    createUserClient({
      url: "https://api.example.com",
      token: "sess-tok",
      asAgent: ".me",
      retries: 0,
    }),
  ).toThrow(/resolved/);
});

test("user client setAsAgent initializes headers when previously unset, then clears", async () => {
  const captured = captureFetch();
  const client = createUserClient({
    url: "https://api.example.com",
    token: "sess-tok",
    retries: 0,
  });

  client.setAsAgent("agent-x");
  await client.whoami();
  expect(captured.headers["X-Me-As-Agent"]).toBe("agent-x");

  client.setAsAgent("");
  captured.headers = {};
  await client.whoami();
  expect(captured.headers["X-Me-As-Agent"]).toBeUndefined();
});

test("user client setAsAgent rejects unresolved .me sentinel", () => {
  const client = createUserClient({
    url: "https://api.example.com",
    token: "sess-tok",
    retries: 0,
  });

  expect(() => client.setAsAgent(".me")).toThrow(/resolved/);
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

test("user client exposes agent.spaces", async () => {
  const captured = captureFetch();
  const client = createUserClient({
    url: "https://api.example.com",
    token: "sess-tok",
    retries: 0,
  });

  await client.agent.spaces({ id: "018f1138-7f07-7c48-8bd1-c9a6b1095978" });

  expect(captured.body).toMatchObject({
    method: "agent.spaces",
    params: { id: "018f1138-7f07-7c48-8bd1-c9a6b1095978" },
  });
});

test("memory client does not retry mutating calls", async () => {
  const captured = captureStatusFetch([500, 200]);
  const client = createMemoryClient({
    url: "https://api.example.com",
    space: "abc123def456",
    retries: 1,
  });

  const error = await captureError(() =>
    client.memory.deleteTree({ tree: "share.wikipedia", dryRun: false }),
  );

  expect(error).toBeInstanceOf(Error);
  expect(captured.calls).toBe(1);
});

test("memory client retries read-only calls", async () => {
  const captured = captureStatusFetch([500, 200]);
  const client = createMemoryClient({
    url: "https://api.example.com",
    space: "abc123def456",
    retries: 1,
  });

  await client.memory.tree();

  expect(captured.calls).toBe(2);
});

test("memory client retries memory.append (the one retryable mutation)", async () => {
  const captured = captureStatusFetch([500, 200]);
  const client = createMemoryClient({
    url: "https://api.example.com",
    space: "abc123def456",
    retries: 1,
  });

  // append carries an operation-scoped idempotency key, so a transport retry
  // replays rather than double-appends — the client retries it (unlike update).
  await client.memory.append({
    id: "018f1138-7f07-7c48-8bd1-c9a6b1095978",
    content: "more",
    idempotencyKey: "op-key-1",
  });

  expect(captured.calls).toBe(2);
});

test("memory client does not retry memory.update", async () => {
  const captured = captureStatusFetch([500, 200]);
  const client = createMemoryClient({
    url: "https://api.example.com",
    space: "abc123def456",
    retries: 1,
  });

  const error = await captureError(() =>
    client.memory.update({
      id: "018f1138-7f07-7c48-8bd1-c9a6b1095978",
      versionHash: "0".repeat(32),
      content: "x",
    }),
  );

  expect(error).toBeInstanceOf(Error);
  expect(captured.calls).toBe(1);
});

test("user client does not retry mutating calls", async () => {
  const captured = captureStatusFetch([500, 200]);
  const client = createUserClient({
    url: "https://api.example.com",
    retries: 1,
  });

  const error = await captureError(() => client.space.create({ name: "test" }));

  expect(error).toBeInstanceOf(Error);
  expect(captured.calls).toBe(1);
});

test("user client retries read-only calls", async () => {
  const captured = captureStatusFetch([500, 200]);
  const client = createUserClient({
    url: "https://api.example.com",
    retries: 1,
  });

  await client.space.list();

  expect(captured.calls).toBe(2);
});
