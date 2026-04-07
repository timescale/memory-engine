import { afterEach, describe, expect, test } from "bun:test";
import {
  checkLimit,
  checkRateLimit,
  cleanupExpiredEntries,
  defaultLimits,
  getClientIp,
  getLimitType,
  getRateLimitStoreSize,
  type RateLimitConfig,
  resetRateLimitStore,
} from "./rate-limit";

// Reset store after each test for isolation
afterEach(() => {
  resetRateLimitStore();
});

describe("getClientIp", () => {
  test("extracts IP from X-Forwarded-For (first entry)", () => {
    const request = new Request("http://localhost/test", {
      headers: {
        "X-Forwarded-For": "203.0.113.195, 70.41.3.18, 150.172.238.178",
      },
    });
    expect(getClientIp(request)).toBe("203.0.113.195");
  });

  test("extracts IP from X-Forwarded-For (single entry)", () => {
    const request = new Request("http://localhost/test", {
      headers: { "X-Forwarded-For": "203.0.113.195" },
    });
    expect(getClientIp(request)).toBe("203.0.113.195");
  });

  test("extracts IP from X-Real-IP", () => {
    const request = new Request("http://localhost/test", {
      headers: { "X-Real-IP": "192.168.1.100" },
    });
    expect(getClientIp(request)).toBe("192.168.1.100");
  });

  test("extracts IP from CF-Connecting-IP", () => {
    const request = new Request("http://localhost/test", {
      headers: { "CF-Connecting-IP": "198.51.100.42" },
    });
    expect(getClientIp(request)).toBe("198.51.100.42");
  });

  test("extracts IP from Fly-Client-IP", () => {
    const request = new Request("http://localhost/test", {
      headers: { "Fly-Client-IP": "172.16.0.50" },
    });
    expect(getClientIp(request)).toBe("172.16.0.50");
  });

  test("prefers X-Forwarded-For over other headers", () => {
    const request = new Request("http://localhost/test", {
      headers: {
        "X-Forwarded-For": "203.0.113.195",
        "X-Real-IP": "192.168.1.100",
        "CF-Connecting-IP": "198.51.100.42",
      },
    });
    expect(getClientIp(request)).toBe("203.0.113.195");
  });

  test("falls back to 127.0.0.1 when no headers present", () => {
    const request = new Request("http://localhost/test");
    expect(getClientIp(request)).toBe("127.0.0.1");
  });

  test("handles empty X-Forwarded-For gracefully", () => {
    const request = new Request("http://localhost/test", {
      headers: { "X-Forwarded-For": "" },
    });
    // Falls through to default since empty string is falsy after trim
    expect(getClientIp(request)).toBe("127.0.0.1");
  });
});

describe("getLimitType", () => {
  test("returns 'none' for health check", () => {
    expect(getLimitType("/health")).toBe("none");
  });

  test("returns 'devicePoll' for device token endpoint", () => {
    expect(getLimitType("/api/v1/auth/device/token")).toBe("devicePoll");
  });

  test("returns 'auth' for auth endpoints", () => {
    expect(getLimitType("/api/v1/auth/device/code")).toBe("auth");
    expect(getLimitType("/api/v1/auth/device/verify")).toBe("auth");
    expect(getLimitType("/api/v1/auth/callback/google")).toBe("auth");
  });

  test("returns 'general' for RPC endpoints", () => {
    expect(getLimitType("/api/v1/accounts/rpc")).toBe("general");
    expect(getLimitType("/api/v1/engine/rpc")).toBe("general");
  });

  test("returns 'general' for unknown paths", () => {
    expect(getLimitType("/unknown")).toBe("general");
    expect(getLimitType("/api/v2/something")).toBe("general");
  });
});

describe("checkLimit", () => {
  const testConfig: RateLimitConfig = {
    maxRequests: 5,
    windowSec: 1,
  };

  test("allows requests under the limit", () => {
    for (let i = 0; i < 5; i++) {
      const result = checkLimit("test-key", testConfig);
      expect(result.allowed).toBe(true);
      expect(result.count).toBe(i + 1);
    }
  });

  test("blocks requests over the limit", () => {
    // Use up all requests
    for (let i = 0; i < 5; i++) {
      checkLimit("test-key", testConfig);
    }

    // Next request should be blocked
    const result = checkLimit("test-key", testConfig);
    expect(result.allowed).toBe(false);
    expect(result.count).toBe(5);
    expect(result.retryAfterSec).toBeGreaterThan(0);
  });

  test("uses separate buckets per key", () => {
    // Fill up key1
    for (let i = 0; i < 5; i++) {
      checkLimit("key1", testConfig);
    }

    // key2 should still work
    const result = checkLimit("key2", testConfig);
    expect(result.allowed).toBe(true);
  });

  test("resets after window expires", async () => {
    // Fill up requests
    for (let i = 0; i < 5; i++) {
      checkLimit("test-key", testConfig);
    }

    // Wait for window to expire
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Should be allowed again
    const result = checkLimit("test-key", testConfig);
    expect(result.allowed).toBe(true);
  });
});

describe("checkRateLimit", () => {
  test("allows requests under the limit", () => {
    const request = new Request("http://localhost/api/v1/accounts/rpc", {
      method: "POST",
      headers: { "X-Forwarded-For": "10.0.0.1" },
    });

    const result = checkRateLimit(request);
    expect(result).toBeNull();
  });

  test("returns null for health endpoint (no rate limiting)", () => {
    // Even after many requests, health should never be limited
    for (let i = 0; i < 200; i++) {
      const request = new Request("http://localhost/health", {
        headers: { "X-Forwarded-For": "10.0.0.1" },
      });
      const result = checkRateLimit(request);
      expect(result).toBeNull();
    }
  });

  test("blocks excessive requests from same IP", () => {
    const limits = {
      general: { maxRequests: 3, windowSec: 60 },
      auth: { maxRequests: 2, windowSec: 60 },
      devicePoll: { maxRequests: 1, windowSec: 60 },
    };

    // First 3 requests should pass
    for (let i = 0; i < 3; i++) {
      const request = new Request("http://localhost/api/v1/accounts/rpc", {
        method: "POST",
        headers: { "X-Forwarded-For": "10.0.0.2" },
      });
      const result = checkRateLimit(request, limits);
      expect(result).toBeNull();
    }

    // 4th request should be blocked
    const request = new Request("http://localhost/api/v1/accounts/rpc", {
      method: "POST",
      headers: { "X-Forwarded-For": "10.0.0.2" },
    });
    const result = checkRateLimit(request, limits);
    expect(result).not.toBeNull();
    expect(result?.status).toBe(429);
  });

  test("returns 429 with Retry-After header", async () => {
    const limits = {
      general: { maxRequests: 1, windowSec: 60 },
      auth: { maxRequests: 1, windowSec: 60 },
      devicePoll: { maxRequests: 1, windowSec: 60 },
    };

    // First request passes
    const request1 = new Request("http://localhost/api/v1/accounts/rpc", {
      method: "POST",
      headers: { "X-Forwarded-For": "10.0.0.3" },
    });
    checkRateLimit(request1, limits);

    // Second request is rate limited
    const request2 = new Request("http://localhost/api/v1/accounts/rpc", {
      method: "POST",
      headers: { "X-Forwarded-For": "10.0.0.3" },
    });
    const result = checkRateLimit(request2, limits);

    expect(result).not.toBeNull();
    expect(result?.status).toBe(429);
    expect(result?.headers.get("Retry-After")).not.toBeNull();

    const body = (await result!.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  test("applies stricter limits to auth endpoints", () => {
    const limits = {
      general: { maxRequests: 100, windowSec: 60 },
      auth: { maxRequests: 2, windowSec: 60 },
      devicePoll: { maxRequests: 1, windowSec: 60 },
    };

    // Auth endpoint should be limited at 2
    for (let i = 0; i < 2; i++) {
      const request = new Request("http://localhost/api/v1/auth/device/code", {
        method: "POST",
        headers: { "X-Forwarded-For": "10.0.0.4" },
      });
      expect(checkRateLimit(request, limits)).toBeNull();
    }

    // 3rd auth request blocked
    const request = new Request("http://localhost/api/v1/auth/device/code", {
      method: "POST",
      headers: { "X-Forwarded-For": "10.0.0.4" },
    });
    expect(checkRateLimit(request, limits)?.status).toBe(429);
  });

  test("applies strictest limits to device token polling", () => {
    const limits = {
      general: { maxRequests: 100, windowSec: 60 },
      auth: { maxRequests: 20, windowSec: 60 },
      devicePoll: { maxRequests: 1, windowSec: 60 },
    };

    // First poll allowed
    const request1 = new Request("http://localhost/api/v1/auth/device/token", {
      method: "POST",
      headers: { "X-Forwarded-For": "10.0.0.5" },
    });
    expect(checkRateLimit(request1, limits)).toBeNull();

    // Second poll blocked immediately
    const request2 = new Request("http://localhost/api/v1/auth/device/token", {
      method: "POST",
      headers: { "X-Forwarded-For": "10.0.0.5" },
    });
    expect(checkRateLimit(request2, limits)?.status).toBe(429);
  });

  test("different IPs have separate limits", () => {
    const limits = {
      general: { maxRequests: 2, windowSec: 60 },
      auth: { maxRequests: 2, windowSec: 60 },
      devicePoll: { maxRequests: 2, windowSec: 60 },
    };

    // IP1 uses its quota
    for (let i = 0; i < 2; i++) {
      const request = new Request("http://localhost/api/v1/accounts/rpc", {
        method: "POST",
        headers: { "X-Forwarded-For": "10.0.0.10" },
      });
      checkRateLimit(request, limits);
    }

    // IP2 should still have its own quota
    const request = new Request("http://localhost/api/v1/accounts/rpc", {
      method: "POST",
      headers: { "X-Forwarded-For": "10.0.0.11" },
    });
    expect(checkRateLimit(request, limits)).toBeNull();
  });
});

describe("store management", () => {
  test("getRateLimitStoreSize returns correct count", () => {
    expect(getRateLimitStoreSize()).toBe(0);

    checkLimit("key1", { maxRequests: 10, windowSec: 60 });
    expect(getRateLimitStoreSize()).toBe(1);

    checkLimit("key2", { maxRequests: 10, windowSec: 60 });
    expect(getRateLimitStoreSize()).toBe(2);

    // Same key doesn't increase count
    checkLimit("key1", { maxRequests: 10, windowSec: 60 });
    expect(getRateLimitStoreSize()).toBe(2);
  });

  test("resetRateLimitStore clears all entries", () => {
    checkLimit("key1", { maxRequests: 10, windowSec: 60 });
    checkLimit("key2", { maxRequests: 10, windowSec: 60 });
    expect(getRateLimitStoreSize()).toBe(2);

    resetRateLimitStore();
    expect(getRateLimitStoreSize()).toBe(0);
  });

  test("cleanupExpiredEntries removes old entries", async () => {
    // Add entries with very short window
    const config = { maxRequests: 10, windowSec: 1 };
    checkLimit("old-key", config);

    expect(getRateLimitStoreSize()).toBe(1);

    // Wait for entries to expire
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Cleanup with 0 maxAge to remove immediately
    const removed = cleanupExpiredEntries(0);
    expect(removed).toBe(1);
    expect(getRateLimitStoreSize()).toBe(0);
  });

  test("cleanupExpiredEntries keeps recent entries", () => {
    checkLimit("recent-key", { maxRequests: 10, windowSec: 60 });

    const removed = cleanupExpiredEntries(600_000); // 10 minute max age
    expect(removed).toBe(0);
    expect(getRateLimitStoreSize()).toBe(1);
  });
});

describe("defaultLimits", () => {
  test("has reasonable default values", () => {
    // General: 100 requests per minute
    expect(defaultLimits.general.maxRequests).toBe(100);
    expect(defaultLimits.general.windowSec).toBe(60);

    // Auth: 20 requests per minute
    expect(defaultLimits.auth.maxRequests).toBe(20);
    expect(defaultLimits.auth.windowSec).toBe(60);

    // Device poll: 10 requests per minute
    expect(defaultLimits.devicePoll.maxRequests).toBe(10);
    expect(defaultLimits.devicePoll.windowSec).toBe(60);
  });
});
