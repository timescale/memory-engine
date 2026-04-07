import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { RPC_ERROR_CODES } from "./errors";
import { createRpcHandler, handleRpcRequest } from "./handler";
import { buildRegistry } from "./registry";

// Helper to create a request with JSON body
function createRequest(body: unknown): Request {
  return new Request("http://localhost/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Helper to create a request with invalid JSON
function createInvalidJsonRequest(): Request {
  return new Request("http://localhost/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not valid json {",
  });
}

describe("handleRpcRequest", () => {
  // Create a test registry with a simple method
  const testRegistry = buildRegistry()
    .register("test.echo", z.object({ message: z.string() }), (params) => ({
      echo: params.message,
    }))
    .register(
      "test.add",
      z.object({ a: z.number(), b: z.number() }),
      (params) => ({ sum: params.a + params.b }),
    )
    .register("test.async", z.object({ delay: z.number() }), async (params) => {
      await new Promise((resolve) => setTimeout(resolve, params.delay));
      return { delayed: true };
    })
    .register("test.throws", z.object({}), () => {
      throw new Error("Intentional error");
    })
    .register("test.noParams", z.undefined(), () => ({
      result: "no params needed",
    }))
    .build();

  describe("parse errors", () => {
    test("returns -32700 for invalid JSON", async () => {
      const request = createInvalidJsonRequest();
      const response = await handleRpcRequest(request, testRegistry);
      const body = (await response.json()) as { error: { code: number } };

      expect(response.status).toBe(200); // JSON-RPC errors use 200
      expect(body.error.code).toBe(RPC_ERROR_CODES.PARSE_ERROR);
    });
  });

  describe("invalid request errors", () => {
    test("returns -32600 for missing jsonrpc field", async () => {
      const request = createRequest({ method: "test.echo", id: 1 });
      const response = await handleRpcRequest(request, testRegistry);
      const body = (await response.json()) as { error: { code: number } };

      expect(body.error.code).toBe(RPC_ERROR_CODES.INVALID_REQUEST);
    });

    test("returns -32600 for wrong jsonrpc version", async () => {
      const request = createRequest({
        jsonrpc: "1.0",
        method: "test.echo",
        id: 1,
      });
      const response = await handleRpcRequest(request, testRegistry);
      const body = (await response.json()) as { error: { code: number } };

      expect(body.error.code).toBe(RPC_ERROR_CODES.INVALID_REQUEST);
    });

    test("returns -32600 for missing method", async () => {
      const request = createRequest({ jsonrpc: "2.0", id: 1 });
      const response = await handleRpcRequest(request, testRegistry);
      const body = (await response.json()) as { error: { code: number } };

      expect(body.error.code).toBe(RPC_ERROR_CODES.INVALID_REQUEST);
    });

    test("returns -32600 for missing id", async () => {
      const request = createRequest({ jsonrpc: "2.0", method: "test.echo" });
      const response = await handleRpcRequest(request, testRegistry);
      const body = (await response.json()) as { error: { code: number } };

      expect(body.error.code).toBe(RPC_ERROR_CODES.INVALID_REQUEST);
    });

    test("returns -32600 for non-object request", async () => {
      const request = createRequest("just a string");
      const response = await handleRpcRequest(request, testRegistry);
      const body = (await response.json()) as { error: { code: number } };

      expect(body.error.code).toBe(RPC_ERROR_CODES.INVALID_REQUEST);
    });

    test("returns -32600 for null request", async () => {
      const request = createRequest(null);
      const response = await handleRpcRequest(request, testRegistry);
      const body = (await response.json()) as { error: { code: number } };

      expect(body.error.code).toBe(RPC_ERROR_CODES.INVALID_REQUEST);
    });
  });

  describe("method not found errors", () => {
    test("returns -32601 for unknown method", async () => {
      const request = createRequest({
        jsonrpc: "2.0",
        method: "unknown.method",
        id: 1,
      });
      const response = await handleRpcRequest(request, testRegistry);
      const body = (await response.json()) as {
        error: { code: number; message: string };
        id: number;
      };

      expect(body.error.code).toBe(RPC_ERROR_CODES.METHOD_NOT_FOUND);
      expect(body.error.message).toContain("unknown.method");
      expect(body.id).toBe(1);
    });
  });

  describe("invalid params errors", () => {
    test("returns -32602 for missing required param", async () => {
      const request = createRequest({
        jsonrpc: "2.0",
        method: "test.echo",
        params: {},
        id: 1,
      });
      const response = await handleRpcRequest(request, testRegistry);
      const body = (await response.json()) as { error: { code: number } };

      expect(body.error.code).toBe(RPC_ERROR_CODES.INVALID_PARAMS);
    });

    test("returns -32602 for wrong param type", async () => {
      const request = createRequest({
        jsonrpc: "2.0",
        method: "test.add",
        params: { a: "not a number", b: 2 },
        id: 1,
      });
      const response = await handleRpcRequest(request, testRegistry);
      const body = (await response.json()) as { error: { code: number } };

      expect(body.error.code).toBe(RPC_ERROR_CODES.INVALID_PARAMS);
    });
  });

  describe("successful calls", () => {
    test("returns result for valid request", async () => {
      const request = createRequest({
        jsonrpc: "2.0",
        method: "test.echo",
        params: { message: "hello" },
        id: 1,
      });
      const response = await handleRpcRequest(request, testRegistry);
      const body = (await response.json()) as {
        jsonrpc: string;
        result: { echo: string };
        id: number;
      };

      expect(body.jsonrpc).toBe("2.0");
      expect(body.result).toEqual({ echo: "hello" });
      expect(body.id).toBe(1);
    });

    test("handles numeric calculations", async () => {
      const request = createRequest({
        jsonrpc: "2.0",
        method: "test.add",
        params: { a: 5, b: 3 },
        id: "string-id",
      });
      const response = await handleRpcRequest(request, testRegistry);
      const body = (await response.json()) as {
        result: { sum: number };
        id: string;
      };

      expect(body.result).toEqual({ sum: 8 });
      expect(body.id).toBe("string-id");
    });

    test("handles async handlers", async () => {
      const request = createRequest({
        jsonrpc: "2.0",
        method: "test.async",
        params: { delay: 10 },
        id: 42,
      });
      const response = await handleRpcRequest(request, testRegistry);
      const body = (await response.json()) as { result: { delayed: boolean } };

      expect(body.result).toEqual({ delayed: true });
    });

    test("handles methods with no params", async () => {
      const request = createRequest({
        jsonrpc: "2.0",
        method: "test.noParams",
        id: 1,
      });
      const response = await handleRpcRequest(request, testRegistry);
      const body = (await response.json()) as { result: { result: string } };

      expect(body.result).toEqual({ result: "no params needed" });
    });
  });

  describe("internal errors", () => {
    test("returns -32603 when handler throws", async () => {
      const request = createRequest({
        jsonrpc: "2.0",
        method: "test.throws",
        params: {},
        id: 1,
      });
      const response = await handleRpcRequest(request, testRegistry);
      const body = (await response.json()) as {
        error: { code: number };
        id: number;
      };

      expect(body.error.code).toBe(RPC_ERROR_CODES.INTERNAL_ERROR);
      expect(body.id).toBe(1);
    });
  });

  describe("id handling", () => {
    test("preserves string id in response", async () => {
      const request = createRequest({
        jsonrpc: "2.0",
        method: "test.echo",
        params: { message: "test" },
        id: "my-request-id",
      });
      const response = await handleRpcRequest(request, testRegistry);
      const body = (await response.json()) as { id: string };

      expect(body.id).toBe("my-request-id");
    });

    test("preserves numeric id in response", async () => {
      const request = createRequest({
        jsonrpc: "2.0",
        method: "test.echo",
        params: { message: "test" },
        id: 12345,
      });
      const response = await handleRpcRequest(request, testRegistry);
      const body = (await response.json()) as { id: number };

      expect(body.id).toBe(12345);
    });
  });
});

describe("createRpcHandler with contextProvider returning Response", () => {
  test("returns Response directly when contextProvider returns Response", async () => {
    const registry = buildRegistry()
      .register("test.method", z.object({}), () => ({ success: true }))
      .build();

    const authErrorResponse = new Response(
      JSON.stringify({
        error: { message: "Unauthorized", code: "UNAUTHORIZED" },
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );

    const handler = createRpcHandler(registry, async () => authErrorResponse);

    const request = new Request("http://localhost/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "test.method",
        params: {},
        id: 1,
      }),
    });

    const response = await handler(request);
    expect(response.status).toBe(401);

    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("passes context to handler when contextProvider returns object", async () => {
    const registry = buildRegistry()
      .register(
        "test.method",
        z.object({}),
        (_params, ctx) =>
          ({
            userId: ctx.userId,
          }) as { userId: string },
      )
      .build();

    const handler = createRpcHandler(registry, async () => ({
      userId: "user-123",
    }));

    const request = new Request("http://localhost/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "test.method",
        params: {},
        id: 1,
      }),
    });

    const response = await handler(request);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { result: { userId: string } };
    expect(body.result.userId).toBe("user-123");
  });
});
