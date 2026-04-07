// packages/server/wiring.integration.test.ts
/**
 * Integration tests for server-database wiring.
 *
 * These tests require a running database with migrations applied.
 * Skip with: SKIP_INTEGRATION=1 bun test
 */

import { describe, expect, mock, test } from "bun:test";
import type { AccountsDB } from "@memory-engine/accounts";
import type { SQL } from "bun";
import type { ServerContext } from "./context";
import { createRouter } from "./router";

const SKIP_INTEGRATION = process.env.SKIP_INTEGRATION === "1";

describe.skipIf(SKIP_INTEGRATION)("Server-Database Wiring Integration", () => {
  // These tests use mocked DB to test the wiring without a real database
  // Full end-to-end tests with real DB can be added separately

  describe("Engine RPC Authentication", () => {
    test("returns 401 for missing Authorization header", async () => {
      const ctx: ServerContext = {
        accountsDb: {
          validateSession: mock(() => Promise.resolve(null)),
          getEngineBySlug: mock(() => Promise.resolve(null)),
        } as unknown as AccountsDB,
        engineSql: {} as SQL,
      };

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
      const ctx: ServerContext = {
        accountsDb: {
          validateSession: mock(() => Promise.resolve(null)),
          getEngineBySlug: mock(() => Promise.resolve(null)),
        } as unknown as AccountsDB,
        engineSql: {} as SQL,
      };

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
      const ctx: ServerContext = {
        accountsDb: {
          validateSession: mock(() => Promise.resolve(null)),
          getEngineBySlug: mock(() => Promise.resolve(null)),
        } as unknown as AccountsDB,
        engineSql: {} as SQL,
      };

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
      const ctx: ServerContext = {
        accountsDb: {
          validateSession: mock(() => Promise.resolve(null)),
          getEngineBySlug: mock(() => Promise.resolve(null)),
        } as unknown as AccountsDB,
        engineSql: {} as SQL,
      };

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
  });

  describe("Health endpoint (no auth)", () => {
    test("returns 200 without authentication", async () => {
      const ctx: ServerContext = {
        accountsDb: {} as AccountsDB,
        engineSql: {} as SQL,
      };

      const router = createRouter(ctx);
      const request = new Request("http://localhost/health");

      const response = await router.handleRequest(request);
      expect(response.status).toBe(200);
    });
  });
});
