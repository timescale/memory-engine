/**
 * Unit tests for server-database wiring.
 *
 * These tests verify that authentication middleware is correctly wired
 * to the router using mocked database connections. They test the wiring
 * logic, not actual database operations.
 *
 * For true integration tests with a real database, see the e2e test suite.
 */

import { describe, expect, mock, test } from "bun:test";
import type { AccountsDB } from "@memory.build/accounts";
import type { AuthStore } from "@memory.build/auth";
import type { EmbeddingConfig } from "@memory.build/embedding";
import type { SQL } from "bun";
import type { Sql } from "postgres";
import { MIN_CLIENT_VERSION, SERVER_VERSION } from "../../version";
import type { ServerContext } from "./context";
import type { EngineInfo } from "./middleware/authenticate";
import { createRouter } from "./router";

// =============================================================================
// Test Helpers
// =============================================================================

function createMockAccountsDb(overrides?: {
  getEngineBySlug?: ReturnType<typeof mock>;
}): AccountsDB {
  return {
    getEngineBySlug:
      overrides?.getEngineBySlug ?? mock(() => Promise.resolve(null)),
  } as unknown as AccountsDB;
}

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

/**
 * Create a mock SQL that has enough methods to not throw, but returns
 * no results. This allows testing wiring without a real database.
 */
function createMockEngineSql(): SQL {
  // Create a function that's also a template tag, returning empty results
  const mockSqlTag = mock(() => Promise.resolve([]));
  // Add the unsafe method for schema/identifier interpolation
  (mockSqlTag as unknown as { unsafe: ReturnType<typeof mock> }).unsafe = mock(
    (str: string) => str,
  );

  const mockTx = Object.assign(
    mock(() => Promise.resolve([])),
    {
      unsafe: mock((str: string) => str),
    },
  );

  return {
    begin: mock((fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)),
  } as unknown as SQL;
}

function createMockContext(overrides?: Partial<ServerContext>): ServerContext {
  return {
    accountsDb: createMockAccountsDb(),
    accountsSql: {} as SQL,
    engineSql: createMockEngineSql(),
    db: {} as Sql,
    auth: createMockAuth(),
    authSchema: "auth",
    coreSchema: "core",
    embeddingConfig: {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      apiKey: "test-key",
    } as EmbeddingConfig,
    apiBaseUrl: "https://test.example.com",
    serverVersion: SERVER_VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("Server-Database Wiring", () => {
  describe("Engine RPC Authentication", () => {
    test("returns 401 for missing Authorization header", async () => {
      const ctx = createMockContext();
      const router = createRouter(ctx);

      const request = new Request("http://localhost/api/v1/engine/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

    test("returns 401 for invalid API key format", async () => {
      const ctx = createMockContext();
      const router = createRouter(ctx);

      const request = new Request("http://localhost/api/v1/engine/rpc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer invalid-key",
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
  });

  describe("Accounts RPC Authentication", () => {
    test("returns 401 for missing Authorization header", async () => {
      const ctx = createMockContext();
      const router = createRouter(ctx);

      const request = new Request("http://localhost/api/v1/accounts/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "me.get",
          params: {},
          id: 1,
        }),
      });

      const response = await router.handleRequest(request);
      expect(response.status).toBe(401);
    });

    test("returns 401 for invalid session token", async () => {
      const ctx = createMockContext();
      const router = createRouter(ctx);

      const request = new Request("http://localhost/api/v1/accounts/rpc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer invalid-session-token",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "me.get",
          params: {},
          id: 1,
        }),
      });

      const response = await router.handleRequest(request);
      expect(response.status).toBe(401);
    });

    test("succeeds with valid session token (happy path)", async () => {
      const mockIdentity = {
        id: "identity-123",
        email: "test@example.com",
        name: "Test User",
      };

      const ctx = createMockContext({
        auth: createMockAuth({
          validateSession: mock(() =>
            Promise.resolve({
              sessionId: "session-1",
              userId: mockIdentity.id,
              email: mockIdentity.email,
              name: mockIdentity.name,
              expiresAt: new Date("2026-12-31T00:00:00Z"),
            }),
          ),
          getUser: mock(() =>
            Promise.resolve({
              id: mockIdentity.id,
              email: mockIdentity.email,
              name: mockIdentity.name,
              emailVerified: true,
              createdAt: new Date("2026-01-01T00:00:00Z"),
              updatedAt: null,
            }),
          ),
        }),
      });
      const router = createRouter(ctx);

      const request = new Request("http://localhost/api/v1/accounts/rpc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer valid-session-token",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "me.get",
          params: {},
          id: 1,
        }),
      });

      const response = await router.handleRequest(request);
      // Should get 200 with RPC response (method may not exist but auth passed)
      expect(response.status).toBe(200);
      const body = await response.json();
      // If method doesn't exist, we get an RPC error, but auth succeeded
      expect(body).toHaveProperty("jsonrpc", "2.0");
    });
  });

  describe("Health endpoint (no auth)", () => {
    test("returns 200 without authentication", async () => {
      const ctx = createMockContext();
      const router = createRouter(ctx);

      const request = new Request("http://localhost/health");

      const response = await router.handleRequest(request);
      expect(response.status).toBe(200);
    });
  });

  describe("Engine RPC wiring verification", () => {
    test("engine lookup is called with slug from API key", async () => {
      const mockEngine: EngineInfo = {
        id: "engine-123",
        orgId: "org-456",
        slug: "abc123xyz789",
        name: "Test Engine",
        shardId: 1,
        status: "active",
      };

      // Verify router correctly extracts slug from API key and calls accountsDb
      // The full auth flow will fail because engineSql is a mock, but we verify
      // the wiring is correct by checking getEngineBySlug was called with the right slug
      const getEngineBySlug = mock(() => Promise.resolve(mockEngine));
      const ctx = createMockContext({
        accountsDb: createMockAccountsDb({ getEngineBySlug }),
      });
      const router = createRouter(ctx);

      // Valid API key format: me.{slug}.{lookupId}.{secret}
      const validApiKey =
        "me.abc123xyz789.Sh00uLs5rmSHHun3.pREy3xfnbCpgUXiaBcDefghij1234567";

      const request = new Request("http://localhost/api/v1/engine/rpc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validApiKey}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "memory.get",
          params: { id: "test-id" },
          id: 1,
        }),
      });

      // Request will fail downstream (mock engineSql lacks required methods),
      // but the wiring we're testing happens before that failure
      const response = await router.handleRequest(request);

      // The response will be an error (500 or similar) because the mock SQL
      // doesn't have required methods, but we're testing the wiring, not the
      // full flow. The important thing is getEngineBySlug was called.
      expect(response.status).toBeGreaterThanOrEqual(400);

      // Verify the engine lookup was called with the correct slug extracted from API key
      expect(getEngineBySlug).toHaveBeenCalledWith("abc123xyz789");
    });
  });
});
