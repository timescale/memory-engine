/**
 * Unit tests for server-database wiring.
 *
 * These verify that the new-model authentication middleware is correctly wired
 * to the router using mocked stores. They test the wiring (which authenticator
 * guards which route, and the shape of its rejections), not real DB operations.
 *
 * For true integration tests with a real database, see the *.integration.test.ts
 * suites under rpc/memory and rpc/user.
 */

import { describe, expect, mock, test } from "bun:test";
import type { AuthStore } from "@memory.build/auth";
import type { EmbeddingConfig } from "@memory.build/embedding";
import type { CoreStore } from "@memory.build/engine/core";
import type { Sql } from "postgres";
import { MIN_CLIENT_VERSION, SERVER_VERSION } from "../../version";
import type { Auth } from "./auth/betterauth";
import type { ServerContext } from "./context";
import { createRouter } from "./router";

// =============================================================================
// Test Helpers
// =============================================================================

function createMockAuth(overrides?: {
  validateSession?: ReturnType<typeof mock>;
  getUser?: ReturnType<typeof mock>;
}): AuthStore {
  return {
    validateSession:
      overrides?.validateSession ?? mock(() => Promise.resolve(null)),
    getUser: overrides?.getUser ?? mock(() => Promise.resolve(null)),
  } as unknown as AuthStore;
}

function createMockContext(overrides?: Partial<ServerContext>): ServerContext {
  return {
    db: {} as Sql,
    auth: createMockAuth(),
    betterAuth: {} as unknown as Auth,
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
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("Server-Database Wiring", () => {
  describe("Memory RPC authentication (authenticateSpace)", () => {
    test("returns 401 for missing Authorization header", async () => {
      const router = createRouter(createMockContext());
      const request = new Request("http://localhost/api/v1/memory/rpc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Me-Space": "abc123def456",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "memory.get",
          params: { id: "test-id" },
          id: 1,
        }),
      });

      const response = await router.handleRequest(request);
      expect(response.status).toBe(401);
    });

    test("returns 400 when the X-Me-Space header is missing", async () => {
      const router = createRouter(createMockContext());
      const request = new Request("http://localhost/api/v1/memory/rpc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer some-token",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "memory.get",
          params: { id: "test-id" },
          id: 1,
        }),
      });

      const response = await router.handleRequest(request);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("MISSING_SPACE");
    });
  });

  describe("User RPC authentication (authenticateUser)", () => {
    test("returns 401 for missing Authorization header", async () => {
      const router = createRouter(createMockContext());
      const request = new Request("http://localhost/api/v1/user/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "whoami",
          params: {},
          id: 1,
        }),
      });

      const response = await router.handleRequest(request);
      expect(response.status).toBe(401);
    });

    test("returns 401 for an invalid session token", async () => {
      const router = createRouter(createMockContext());
      const request = new Request("http://localhost/api/v1/user/rpc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer invalid-session-token",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "whoami",
          params: {},
          id: 1,
        }),
      });

      const response = await router.handleRequest(request);
      expect(response.status).toBe(401);
    });

    test("whoami succeeds with a valid session (happy path)", async () => {
      const identity = {
        id: "01960000-0000-7000-8000-000000000000",
        email: "test@example.com",
        name: "Test User",
      };
      const ctx = createMockContext({
        auth: createMockAuth({
          validateSession: mock(() =>
            Promise.resolve({
              sessionId: "session-1",
              userId: identity.id,
              email: identity.email,
              name: identity.name,
              expiresAt: new Date("2026-12-31T00:00:00Z"),
            }),
          ),
          getUser: mock(() =>
            Promise.resolve({
              id: identity.id,
              email: identity.email,
              name: identity.name,
              emailVerified: true,
              createdAt: new Date("2026-01-01T00:00:00Z"),
              updatedAt: null,
            }),
          ),
        }),
      });
      const router = createRouter(ctx);

      const request = new Request("http://localhost/api/v1/user/rpc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer valid-session-token",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "whoami",
          params: {},
          id: 1,
        }),
      });

      const response = await router.handleRequest(request);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        jsonrpc: string;
        result: { id: string; email: string; name: string };
      };
      expect(body.jsonrpc).toBe("2.0");
      expect(body.result).toEqual(identity);
    });
  });

  describe("Health endpoint (no auth)", () => {
    test("returns 200 without authentication", async () => {
      const router = createRouter(createMockContext());
      const request = new Request("http://localhost/health");
      const response = await router.handleRequest(request);
      expect(response.status).toBe(200);
    });
  });
});
