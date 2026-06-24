import { describe, expect, test } from "bun:test";
import type { EmbeddingConfig } from "@memory.build/embedding";
import type { CoreStore } from "@memory.build/engine/core";
import type { Sql } from "postgres";
import { MIN_CLIENT_VERSION, SERVER_VERSION } from "../../version";
import type { Auth } from "./auth/betterauth";
import type { ServerContext } from "./context";
import { createRouter } from "./router";

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

  describe("auth endpoints (better-auth catch-all)", () => {
    test("routes better-auth sub-paths (any method) to the catch-all", () => {
      const cases: Array<[string, string]> = [
        ["POST", "/api/v1/auth/sign-in/social"],
        ["GET", "/api/v1/auth/oauth2/authorize"],
        ["POST", "/api/v1/auth/oauth2/token"],
        ["POST", "/api/v1/auth/sign-out"],
      ];
      for (const [method, path] of cases) {
        const match = router.matchRoute(method, path);
        expect(match?.route.pattern).toBe("/api/v1/auth/*");
      }
    });

    test("routes OAuth callbacks to the catch-all (provider in the wildcard)", () => {
      const match = router.matchRoute("GET", "/api/v1/auth/callback/github");
      expect(match?.route.pattern).toBe("/api/v1/auth/*");
      expect(match?.params["*"]).toBe("callback/github");
    });

    test("better-auth owns the whole /api/v1/auth/* namespace", () => {
      // Unknown sub-paths still match the catch-all; better-auth returns its
      // own 404 rather than the router treating it as unmatched.
      const match = router.matchRoute("GET", "/api/v1/auth/unknown/path");
      expect(match?.route.pattern).toBe("/api/v1/auth/*");
    });
  });

  describe("memory RPC endpoint", () => {
    test("matches POST /api/v1/memory/rpc", () => {
      const match = router.matchRoute("POST", "/api/v1/memory/rpc");
      expect(match).not.toBeNull();
      expect(match?.route.pattern).toBe("/api/v1/memory/rpc");
      expect(match?.params).toEqual({});
    });

    test("does not match GET /api/v1/memory/rpc", () => {
      const match = router.matchRoute("GET", "/api/v1/memory/rpc");
      expect(match).toBeNull();
    });
  });

  describe("user RPC endpoint", () => {
    test("matches POST /api/v1/user/rpc", () => {
      const match = router.matchRoute("POST", "/api/v1/user/rpc");
      expect(match).not.toBeNull();
      expect(match?.route.pattern).toBe("/api/v1/user/rpc");
      expect(match?.params).toEqual({});
    });

    test("does not match GET /api/v1/user/rpc", () => {
      const match = router.matchRoute("GET", "/api/v1/user/rpc");
      expect(match).toBeNull();
    });
  });

  describe("version endpoint", () => {
    test("matches GET /api/v1/version", () => {
      const match = router.matchRoute("GET", "/api/v1/version");
      expect(match).not.toBeNull();
      expect(match?.route.pattern).toBe("/api/v1/version");
      expect(match?.params).toEqual({});
    });

    test("does not match POST /api/v1/version", () => {
      const match = router.matchRoute("POST", "/api/v1/version");
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
  test("returns JSON 404 for unknown /api/* routes", async () => {
    const ctx = createMockContext();
    const router = createRouter(ctx);

    const request = new Request("http://localhost/api/v1/nope");
    const response = await router.handleRequest(request);

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });

  test("serves the SPA for a non-API GET (client-side route)", async () => {
    const ctx = createMockContext();
    const router = createRouter(ctx);

    // No build is present in unit tests, so the static handler returns its
    // placeholder index — the point is it's served (200 HTML), not a 404.
    const request = new Request("http://localhost/some/app/route");
    const response = await router.handleRequest(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
  });

  test("returns 405 for a non-GET on a non-API path", async () => {
    const ctx = createMockContext();
    const router = createRouter(ctx);

    const request = new Request("http://localhost/some/route", {
      method: "DELETE",
    });
    const response = await router.handleRequest(request);

    expect(response.status).toBe(405);
  });

  test("handles health check", async () => {
    const ctx = createMockContext();
    const router = createRouter(ctx);

    const request = new Request("http://localhost/health");
    const response = await router.handleRequest(request);

    expect(response.status).toBe(200);
  });

  test("handles version probe", async () => {
    const ctx = createMockContext();
    const router = createRouter(ctx);

    const request = new Request("http://localhost/api/v1/version");
    const response = await router.handleRequest(request);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      serverVersion: string;
      minClientVersion: string;
    };
    expect(body.serverVersion).toBe(SERVER_VERSION);
    expect(body.minClientVersion).toBe(MIN_CLIENT_VERSION);
  });

  test("rejects RPC requests with too-old X-Client-Version", async () => {
    const ctx = createMockContext();
    const router = createRouter(ctx);

    const request = new Request("http://localhost/api/v1/memory/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Version": "0.0.1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "memory.create",
        params: {},
        id: 1,
      }),
    });
    const response = await router.handleRequest(request);

    expect(response.status).toBe(426);
    const body = (await response.json()) as {
      jsonrpc: string;
      error: { code: number; data?: { code: string } };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.data?.code).toBe("CLIENT_VERSION_INCOMPATIBLE");
  });

  test("allows RPC requests without X-Client-Version (lenient mode)", async () => {
    const ctx = createMockContext();
    const router = createRouter(ctx);

    const request = new Request("http://localhost/api/v1/memory/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "memory.create",
        params: {},
        id: 1,
      }),
    });
    const response = await router.handleRequest(request);

    // Without auth this will 401, NOT 426 — proves the version check passed
    // and the auth middleware is what rejected it.
    expect(response.status).not.toBe(426);
  });
});
