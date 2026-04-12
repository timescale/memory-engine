import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { AccountsDB } from "@memory-engine/accounts";
import type { EmbeddingConfig } from "@memory-engine/embedding";
import type { SQL } from "bun";
import { APP_VERSION } from "../../version";
import type { ServerContext } from "./context";
import { MAX_BODY_SIZE } from "./middleware/size-limit";

// Test server instance
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

// Mock ServerContext for testing
function createMockContext(): ServerContext {
  return {
    accountsDb: {
      validateSession: mock(() => Promise.resolve(null)),
      getEngineBySlug: mock(() => Promise.resolve(null)),
      // Device auth operations for auth endpoint tests
      create: mock(() => Promise.resolve({})),
      getByDeviceCode: mock(() => Promise.resolve(null)),
      getByUserCode: mock(() => Promise.resolve(null)),
      getByOAuthState: mock(() => Promise.resolve(null)),
      updateLastPoll: mock(() => Promise.resolve(null)),
      authorize: mock(() => Promise.resolve(false)),
      deny: mock(() => Promise.resolve(false)),
      delete: mock(() => Promise.resolve(false)),
      deleteExpired: mock(() => Promise.resolve(0)),
    } as unknown as AccountsDB,
    accountsSql: {} as SQL,
    engineSql: {} as SQL,
    embeddingConfig: {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      apiKey: "test-key",
    } as EmbeddingConfig,
    apiBaseUrl: "https://test.example.com",
    appVersion: APP_VERSION,
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

  describe("404 handling", () => {
    test("unknown path returns 404", async () => {
      const response = await fetch(`${baseUrl}/unknown`);
      expect(response.status).toBe(404);
    });

    test("root path returns 404", async () => {
      const response = await fetch(`${baseUrl}/`);
      expect(response.status).toBe(404);
    });

    test("404 response has correct body", async () => {
      const response = await fetch(`${baseUrl}/unknown`);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });

  describe("size limit", () => {
    test("rejects requests with oversized Content-Length header", async () => {
      // Create a request with a misleading Content-Length header
      // In real scenarios, the header would match the actual body
      const request = new Request(`${baseUrl}/api/v1/accounts/rpc`, {
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
      const response = await fetch(`${baseUrl}/api/v1/accounts/rpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "test", id: 1 }),
      });
      // Should get 401 (auth required) not 413 (size limit)
      // Auth is checked after size limit passes
      expect(response.status).toBe(401);
    });
  });

  describe("RPC endpoints", () => {
    test("POST /api/v1/accounts/rpc returns 401 without auth", async () => {
      const response = await fetch(`${baseUrl}/api/v1/accounts/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      // Auth is required before JSON-RPC processing
      expect(response.status).toBe(401);
    });

    test("POST /api/v1/accounts/rpc returns 401 for unauthenticated requests", async () => {
      const response = await fetch(`${baseUrl}/api/v1/accounts/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "unknown.method",
          id: 1,
        }),
      });
      // Auth is required before method lookup
      expect(response.status).toBe(401);
    });

    test("POST /api/v1/engine/rpc returns 401 without auth", async () => {
      const response = await fetch(`${baseUrl}/api/v1/engine/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "unknown.method",
          id: 1,
        }),
      });
      // Auth is required before method lookup
      expect(response.status).toBe(401);
    });

    test("GET /api/v1/accounts/rpc returns 404 (wrong method)", async () => {
      const response = await fetch(`${baseUrl}/api/v1/accounts/rpc`);
      expect(response.status).toBe(404);
    });
  });

  describe("auth endpoints", () => {
    test("POST /api/v1/auth/device/code returns device code for valid provider", async () => {
      const response = await fetch(`${baseUrl}/api/v1/auth/device/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google" }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        deviceCode: string;
        userCode: string;
        verificationUri: string;
        expiresIn: number;
        interval: number;
      };
      expect(body.deviceCode).toBeDefined();
      expect(body.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(body.verificationUri).toContain("/api/v1/auth/device/verify");
      expect(body.expiresIn).toBe(900);
      expect(body.interval).toBe(5);
    });

    test("POST /api/v1/auth/device/code rejects invalid provider", async () => {
      const response = await fetch(`${baseUrl}/api/v1/auth/device/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "invalid" }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_PROVIDER");
    });

    test("POST /api/v1/auth/device/code rejects invalid JSON", async () => {
      const response = await fetch(`${baseUrl}/api/v1/auth/device/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(response.status).toBe(400);
    });

    test("GET /api/v1/auth/device/verify returns HTML form", async () => {
      const response = await fetch(`${baseUrl}/api/v1/auth/device/verify`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/html");
      const html = await response.text();
      expect(html).toContain("Sign in to Memory Engine");
      expect(html).toContain("<form");
    });

    test("GET /api/v1/auth/callback/google returns 400 without code/state", async () => {
      const response = await fetch(`${baseUrl}/api/v1/auth/callback/google`);
      expect(response.status).toBe(400);
      expect(response.headers.get("Content-Type")).toContain("text/html");
    });

    test("POST /api/v1/auth/device/token rejects missing deviceCode", async () => {
      const response = await fetch(`${baseUrl}/api/v1/auth/device/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
    });

    test("POST /api/v1/auth/device/token returns expired_token for unknown code", async () => {
      const response = await fetch(`${baseUrl}/api/v1/auth/device/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceCode: "nonexistent-code" }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("expired_token");
    });
  });
});
