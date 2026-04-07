import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MAX_BODY_SIZE } from "./middleware/size-limit";

// Test server instance
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(async () => {
  // Start server on random port for testing
  const port = 0; // Let OS assign a port

  // We need to create a minimal server for testing since index.ts
  // uses await configure() at top level which makes it hard to import
  const { handleRequest } = await import("./router");
  const { checkSizeLimit, checkRateLimit } = await import("./middleware");
  const { internalError } = await import("./util/response");

  server = Bun.serve({
    port,
    async fetch(request) {
      try {
        // 1. Check size limit
        const sizeError = checkSizeLimit(request);
        if (sizeError) {
          return sizeError;
        }

        // 2. Check rate limit
        const rateLimitError = checkRateLimit(request);
        if (rateLimitError) {
          return rateLimitError;
        }

        // 3. Route and handle request
        return await handleRequest(request);
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
        body: JSON.stringify({ test: "data" }),
      });
      // Should get 501 (not implemented) not 413
      expect(response.status).toBe(501);
    });
  });

  describe("RPC endpoints (stubs)", () => {
    test("POST /api/v1/accounts/rpc returns 501", async () => {
      const response = await fetch(`${baseUrl}/api/v1/accounts/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(501);
    });

    test("POST /api/v1/engine/rpc returns 501", async () => {
      const response = await fetch(`${baseUrl}/api/v1/engine/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(501);
    });

    test("GET /api/v1/accounts/rpc returns 404 (wrong method)", async () => {
      const response = await fetch(`${baseUrl}/api/v1/accounts/rpc`);
      expect(response.status).toBe(404);
    });
  });

  describe("auth endpoints (stubs)", () => {
    test("POST /api/v1/auth/device/code returns 501", async () => {
      const response = await fetch(`${baseUrl}/api/v1/auth/device/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google" }),
      });
      expect(response.status).toBe(501);
    });

    test("GET /api/v1/auth/callback/google returns 501", async () => {
      const response = await fetch(`${baseUrl}/api/v1/auth/callback/google`);
      expect(response.status).toBe(501);
    });
  });
});
