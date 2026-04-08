import { describe, expect, mock, test } from "bun:test";
import type { AccountsDB } from "@memory-engine/accounts";
import type { EmbeddingConfig } from "@memory-engine/embedding";
import type { SQL } from "bun";
import type { ServerContext } from "./context";
import { createRouter } from "./router";

// Mock ServerContext for testing
function createMockContext(): ServerContext {
  return {
    accountsDb: {
      validateSession: mock(() => Promise.resolve(null)),
      getEngineBySlug: mock(() => Promise.resolve(null)),
    } as unknown as AccountsDB,
    engineSql: {} as SQL,
    embeddingConfig: {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      apiKey: "test-key",
    } as EmbeddingConfig,
    apiBaseUrl: "https://test.example.com",
    appVersion: "0.1.0",
  };
}

describe("createRouter", () => {
  test("creates router with handleRequest function", () => {
    const ctx = createMockContext();
    const router = createRouter(ctx);
    expect(typeof router.handleRequest).toBe("function");
    expect(typeof router.matchRoute).toBe("function");
  });
});

describe("matchRoute", () => {
  const ctx = createMockContext();
  const router = createRouter(ctx);

  describe("health endpoint", () => {
    test("matches GET /health", () => {
      const match = router.matchRoute("GET", "/health");
      expect(match).not.toBeNull();
      expect(match?.route.pattern).toBe("/health");
      expect(match?.params).toEqual({});
    });

    test("does not match POST /health", () => {
      const match = router.matchRoute("POST", "/health");
      expect(match).toBeNull();
    });

    test("does not match GET /health/extra", () => {
      const match = router.matchRoute("GET", "/health/extra");
      expect(match).toBeNull();
    });
  });

  describe("auth endpoints", () => {
    test("matches POST /api/v1/auth/device/code", () => {
      const match = router.matchRoute("POST", "/api/v1/auth/device/code");
      expect(match).not.toBeNull();
      expect(match?.route.pattern).toBe("/api/v1/auth/device/code");
    });

    test("matches POST /api/v1/auth/device/token", () => {
      const match = router.matchRoute("POST", "/api/v1/auth/device/token");
      expect(match).not.toBeNull();
      expect(match?.route.pattern).toBe("/api/v1/auth/device/token");
    });

    test("matches GET /api/v1/auth/device/verify", () => {
      const match = router.matchRoute("GET", "/api/v1/auth/device/verify");
      expect(match).not.toBeNull();
      expect(match?.route.pattern).toBe("/api/v1/auth/device/verify");
    });

    test("matches POST /api/v1/auth/device/verify", () => {
      const match = router.matchRoute("POST", "/api/v1/auth/device/verify");
      expect(match).not.toBeNull();
      expect(match?.route.pattern).toBe("/api/v1/auth/device/verify");
    });

    test("matches GET /api/v1/auth/callback/:provider with params", () => {
      const match = router.matchRoute("GET", "/api/v1/auth/callback/google");
      expect(match).not.toBeNull();
      expect(match?.route.pattern).toBe("/api/v1/auth/callback/:provider");
      expect(match?.params.provider).toBe("google");
    });

    test("matches GET /api/v1/auth/callback/github", () => {
      const match = router.matchRoute("GET", "/api/v1/auth/callback/github");
      expect(match).not.toBeNull();
      expect(match?.params.provider).toBe("github");
    });

    test("does not match unknown auth paths", () => {
      const match = router.matchRoute("GET", "/api/v1/auth/unknown/path");
      expect(match).toBeNull();
    });
  });

  describe("accounts RPC endpoint", () => {
    test("matches POST /api/v1/accounts/rpc", () => {
      const match = router.matchRoute("POST", "/api/v1/accounts/rpc");
      expect(match).not.toBeNull();
      expect(match?.route.pattern).toBe("/api/v1/accounts/rpc");
      expect(match?.params).toEqual({});
    });

    test("does not match GET /api/v1/accounts/rpc", () => {
      const match = router.matchRoute("GET", "/api/v1/accounts/rpc");
      expect(match).toBeNull();
    });
  });

  describe("engine RPC endpoint", () => {
    test("matches POST /api/v1/engine/rpc", () => {
      const match = router.matchRoute("POST", "/api/v1/engine/rpc");
      expect(match).not.toBeNull();
      expect(match?.route.pattern).toBe("/api/v1/engine/rpc");
      expect(match?.params).toEqual({});
    });

    test("does not match GET /api/v1/engine/rpc", () => {
      const match = router.matchRoute("GET", "/api/v1/engine/rpc");
      expect(match).toBeNull();
    });
  });

  describe("unknown paths", () => {
    test("returns null for unknown path", () => {
      const match = router.matchRoute("GET", "/unknown");
      expect(match).toBeNull();
    });

    test("returns null for root path", () => {
      const match = router.matchRoute("GET", "/");
      expect(match).toBeNull();
    });

    test("returns null for /api without version", () => {
      const match = router.matchRoute("GET", "/api");
      expect(match).toBeNull();
    });
  });
});

describe("handleRequest", () => {
  test("returns 404 for unmatched routes", async () => {
    const ctx = createMockContext();
    const router = createRouter(ctx);

    const request = new Request("http://localhost/nonexistent");
    const response = await router.handleRequest(request);

    expect(response.status).toBe(404);
  });

  test("handles health check", async () => {
    const ctx = createMockContext();
    const router = createRouter(ctx);

    const request = new Request("http://localhost/health");
    const response = await router.handleRequest(request);

    expect(response.status).toBe(200);
  });
});
