import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EmbeddingConfig } from "@memory.build/embedding";
import type { CoreStore } from "@memory.build/engine/core";
import type { Sql } from "postgres";
import { MIN_CLIENT_VERSION, SERVER_VERSION } from "../../version";
import type { Auth } from "./auth/betterauth";
import type { ServerContext } from "./context";
import { MAX_BODY_SIZE } from "./middleware/size-limit";

// Test server instance
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

// Mock ServerContext for testing
function createMockContext(): ServerContext {
  return {
    db: {} as Sql,
    betterAuth: {} as unknown as Auth,
    verifyOAuthToken: async () => null,
    core: {} as unknown as CoreStore,
    authSchema: "auth",
    coreSchema: "core",
    embeddingConfig: {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      apiKey: "test-key",
    } as EmbeddingConfig,
    apiBaseUrl: "https://test.example.com",
    webDist: "packages/web/dist",
    webAllowedOrigins: ["https://test.example.com"],
    serverVersion: SERVER_VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
  };
}

beforeAll(async () => {
  // Start server on random port for testing
  const port = 0; // Let OS assign a port

  // We need to create a minimal server for testing since index.ts
  // uses await configure() at top level which makes it hard to import
  const { createRouter } = await import("./router");
  const { checkSizeLimit } = await import("./middleware");
  const { internalError } = await import("./util/response");

  const ctx = createMockContext();
  const router = createRouter(ctx);

  server = Bun.serve({
    port,
    async fetch(request) {
      try {
        // Check size limit
        const sizeError = checkSizeLimit(request);
        if (sizeError) {
          return sizeError;
        }

        // Route and handle request
        return await router.handleRequest(request);
      } catch (_error) {
        return internalError();
      }
    },
  });

  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
});

describe("server integration", () => {
  describe("health endpoint", () => {
    test("GET /health returns 200 ok", async () => {
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    });

    test("GET /health has correct content type", async () => {
      const response = await fetch(`${baseUrl}/health`);
      expect(response.headers.get("Content-Type")).toBe("text/plain");
    });
  });

  describe("static + 404 handling", () => {
    test("unknown /api/* path returns a JSON 404", async () => {
      const response = await fetch(`${baseUrl}/api/v1/unknown`);
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_FOUND");
    });

    test("a non-API path serves the SPA (200 HTML)", async () => {
      const response = await fetch(`${baseUrl}/some/app/route`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/html");
    });

    test("root path serves the SPA (200 HTML)", async () => {
      const response = await fetch(`${baseUrl}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/html");
    });
  });

  describe("size limit", () => {
    test("rejects requests with oversized Content-Length header", async () => {
      // Create a request with a misleading Content-Length header
      // In real scenarios, the header would match the actual body
      const request = new Request(`${baseUrl}/api/v1/memory/rpc`, {
        method: "POST",
        headers: {
          "Content-Length": String(MAX_BODY_SIZE + 1),
          "Content-Type": "application/json",
        },
      });

      // Test the middleware directly since fetch normalizes Content-Length
      const { checkSizeLimit } = await import("./middleware/size-limit");
      const result = checkSizeLimit(request);
      expect(result).not.toBeNull();
      expect(result?.status).toBe(413);
    });

    test("allows normal sized requests", async () => {
      const response = await fetch(`${baseUrl}/api/v1/user/rpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "whoami", id: 1 }),
      });
      // Should get 401 (auth required) not 413 (size limit)
      // Auth is checked after size limit passes
      expect(response.status).toBe(401);
    });
  });

  describe("RPC endpoints", () => {
    test("POST /api/v1/memory/rpc returns 401 without auth", async () => {
      const response = await fetch(`${baseUrl}/api/v1/memory/rpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Me-Space": "abc123def456",
        },
        body: JSON.stringify({}),
      });
      // Auth is required before JSON-RPC processing
      expect(response.status).toBe(401);
    });

    test("POST /api/v1/memory/rpc returns 400 when X-Me-Space is missing", async () => {
      const response = await fetch(`${baseUrl}/api/v1/memory/rpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer some-token",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "memory.get", id: 1 }),
      });
      expect(response.status).toBe(400);
    });

    test("POST /api/v1/user/rpc returns 401 for unauthenticated requests", async () => {
      const response = await fetch(`${baseUrl}/api/v1/user/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "whoami",
          id: 1,
        }),
      });
      // Auth is required before method lookup
      expect(response.status).toBe(401);
    });

    test("GET /api/v1/memory/rpc returns 404 (wrong method)", async () => {
      const response = await fetch(`${baseUrl}/api/v1/memory/rpc`);
      expect(response.status).toBe(404);
    });
  });

  // The /api/v1/auth/* surface is owned end-to-end by better-auth (social
  // sign-in, OAuth authorize/token, sessions) and exercised against a real
  // instance in the auth + middleware integration suites, not this mock router.
});
