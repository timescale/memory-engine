import { describe, expect, test } from "bun:test";
import { matchRoute } from "./router";

describe("matchRoute", () => {
  describe("health endpoint", () => {
    test("matches GET /health", () => {
      const match = matchRoute("GET", "/health");
      expect(match).not.toBeNull();
      expect(match?.route.pattern).toBe("/health");
      expect(match?.params).toEqual({});
    });

    test("does not match POST /health", () => {
      const match = matchRoute("POST", "/health");
      expect(match).toBeNull();
    });

    test("does not match GET /health/extra", () => {
      const match = matchRoute("GET", "/health/extra");
      expect(match).toBeNull();
    });
  });

  describe("auth endpoints", () => {
    test("matches /api/v1/auth/device/code", () => {
      const match = matchRoute("POST", "/api/v1/auth/device/code");
      expect(match).not.toBeNull();
      expect(match?.route.pattern).toBe("/api/v1/auth/*");
    });

    test("matches /api/v1/auth/device/token", () => {
      const match = matchRoute("POST", "/api/v1/auth/device/token");
      expect(match).not.toBeNull();
      expect(match?.route.pattern).toBe("/api/v1/auth/*");
    });

    test("matches /api/v1/auth/callback/google", () => {
      const match = matchRoute("GET", "/api/v1/auth/callback/google");
      expect(match).not.toBeNull();
      expect(match?.route.pattern).toBe("/api/v1/auth/*");
    });

    test("matches any method for auth wildcard", () => {
      const getMatch = matchRoute("GET", "/api/v1/auth/test");
      const postMatch = matchRoute("POST", "/api/v1/auth/test");
      expect(getMatch).not.toBeNull();
      expect(postMatch).not.toBeNull();
    });
  });

  describe("accounts RPC endpoint", () => {
    test("matches POST /api/v1/accounts/rpc", () => {
      const match = matchRoute("POST", "/api/v1/accounts/rpc");
      expect(match).not.toBeNull();
      expect(match?.route.pattern).toBe("/api/v1/accounts/rpc");
      expect(match?.params).toEqual({});
    });

    test("does not match GET /api/v1/accounts/rpc", () => {
      const match = matchRoute("GET", "/api/v1/accounts/rpc");
      expect(match).toBeNull();
    });
  });

  describe("engine RPC endpoint", () => {
    test("matches POST /api/v1/engine/rpc", () => {
      const match = matchRoute("POST", "/api/v1/engine/rpc");
      expect(match).not.toBeNull();
      expect(match?.route.pattern).toBe("/api/v1/engine/rpc");
      expect(match?.params).toEqual({});
    });

    test("does not match GET /api/v1/engine/rpc", () => {
      const match = matchRoute("GET", "/api/v1/engine/rpc");
      expect(match).toBeNull();
    });
  });

  describe("unknown paths", () => {
    test("returns null for unknown path", () => {
      const match = matchRoute("GET", "/unknown");
      expect(match).toBeNull();
    });

    test("returns null for root path", () => {
      const match = matchRoute("GET", "/");
      expect(match).toBeNull();
    });

    test("returns null for /api without version", () => {
      const match = matchRoute("GET", "/api");
      expect(match).toBeNull();
    });
  });
});
