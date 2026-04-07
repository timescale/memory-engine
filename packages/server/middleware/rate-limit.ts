/**
 * Rate limiting middleware using sliding window algorithm.
 *
 * Tracks requests by client identifier (IP address or authenticated user/identity ID).
 * Uses in-memory storage - suitable for single instance, upgrade to Redis for clustering.
 */

import { tooManyRequests } from "../util/response";

/**
 * Rate limit configuration for a specific limit type.
 */
export interface RateLimitConfig {
  /** Maximum requests allowed in the window */
  maxRequests: number;
  /** Window duration in seconds */
  windowSec: number;
}

/**
 * Entry tracking requests from a single client.
 */
interface RateLimitEntry {
  /** Timestamps of requests within the current window */
  timestamps: number[];
  /** Last cleanup time to avoid cleaning on every request */
  lastCleanup: number;
}

/**
 * Rate limit store - maps client identifier to request history.
 */
const store = new Map<string, RateLimitEntry>();

/**
 * Default rate limits.
 *
 * Conservative defaults that can be overridden via environment variables.
 */
export const defaultLimits = {
  /** General requests (by IP) */
  general: {
    maxRequests: 100,
    windowSec: 60,
  } satisfies RateLimitConfig,

  /** Auth endpoints - tighter limits to prevent brute force */
  auth: {
    maxRequests: 20,
    windowSec: 60,
  } satisfies RateLimitConfig,

  /** Device code polling - even tighter to prevent abuse */
  devicePoll: {
    maxRequests: 10,
    windowSec: 60,
  } satisfies RateLimitConfig,
};

/**
 * Get the client IP address from a request.
 *
 * Checks standard proxy headers in order of preference.
 * Falls back to a default for testing/development.
 */
export function getClientIp(request: Request): string {
  // X-Forwarded-For: client, proxy1, proxy2
  const forwarded = request.headers.get("X-Forwarded-For");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  // X-Real-IP (nginx)
  const realIp = request.headers.get("X-Real-IP");
  if (realIp) return realIp;

  // CF-Connecting-IP (Cloudflare)
  const cfIp = request.headers.get("CF-Connecting-IP");
  if (cfIp) return cfIp;

  // Fly-Client-IP (Fly.io)
  const flyIp = request.headers.get("Fly-Client-IP");
  if (flyIp) return flyIp;

  // Fallback for direct connections / testing
  return "127.0.0.1";
}

/**
 * Determine rate limit type based on request path.
 */
export function getLimitType(
  path: string,
): "general" | "auth" | "devicePoll" | "none" {
  // No rate limiting for health checks
  if (path === "/health") {
    return "none";
  }

  // Device token polling - strictest limit
  if (path === "/api/v1/auth/device/token") {
    return "devicePoll";
  }

  // Auth endpoints - stricter limits
  if (path.startsWith("/api/v1/auth/")) {
    return "auth";
  }

  // Everything else - general limit
  return "general";
}

/**
 * Clean up old timestamps from an entry.
 * Only cleans if enough time has passed since last cleanup.
 */
function cleanupEntry(entry: RateLimitEntry, windowMs: number): void {
  const now = Date.now();

  // Only cleanup every second to avoid overhead
  if (now - entry.lastCleanup < 1000) {
    return;
  }

  const cutoff = now - windowMs;
  entry.timestamps = entry.timestamps.filter((ts) => ts > cutoff);
  entry.lastCleanup = now;
}

/**
 * Check if a request is allowed under the rate limit.
 *
 * @param key - Unique identifier for the client (IP or user ID)
 * @param config - Rate limit configuration
 * @returns Object with allowed status, current count, and retry-after seconds
 */
export function checkLimit(
  key: string,
  config: RateLimitConfig,
): { allowed: boolean; count: number; retryAfterSec: number } {
  const now = Date.now();
  const windowMs = config.windowSec * 1000;
  const cutoff = now - windowMs;

  let entry = store.get(key);

  if (!entry) {
    entry = { timestamps: [], lastCleanup: now };
    store.set(key, entry);
  }

  // Clean up old timestamps
  cleanupEntry(entry, windowMs);

  // Count requests in current window
  const count = entry.timestamps.filter((ts) => ts > cutoff).length;

  if (count >= config.maxRequests) {
    // Calculate when the oldest request in the window will expire
    const oldestInWindow = entry.timestamps.find((ts) => ts > cutoff);
    const retryAfterMs = oldestInWindow
      ? oldestInWindow + windowMs - now
      : windowMs;
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);

    return { allowed: false, count, retryAfterSec };
  }

  // Request allowed - record timestamp
  entry.timestamps.push(now);

  return { allowed: true, count: count + 1, retryAfterSec: 0 };
}

/**
 * Check rate limit for a request.
 *
 * Uses IP address as the client identifier. For authenticated endpoints,
 * per-user rate limiting can be applied separately after authentication.
 *
 * @param request - The incoming HTTP request
 * @param overrideLimits - Optional override for rate limits (useful for testing)
 * @returns null if allowed, 429 Response if rate limited
 */
export function checkRateLimit(
  request: Request,
  overrideLimits?: typeof defaultLimits,
): Response | null {
  const url = new URL(request.url);
  const path = url.pathname;
  const limitType = getLimitType(path);

  // No rate limiting for this path
  if (limitType === "none") {
    return null;
  }

  const limits = overrideLimits ?? defaultLimits;
  const config = limits[limitType];
  const clientIp = getClientIp(request);

  // Include limit type in key to have separate buckets per endpoint type
  const key = `${limitType}:${clientIp}`;

  const result = checkLimit(key, config);

  if (!result.allowed) {
    return tooManyRequests(result.retryAfterSec);
  }

  return null;
}

/**
 * Reset the rate limit store.
 * Primarily for testing.
 */
export function resetRateLimitStore(): void {
  store.clear();
}

/**
 * Get current store size.
 * Useful for monitoring memory usage.
 */
export function getRateLimitStoreSize(): number {
  return store.size;
}

/**
 * Periodically clean up expired entries from the store.
 * Should be called on a timer (e.g., every 5 minutes) to prevent memory growth.
 *
 * @param maxAge - Maximum age in milliseconds for entries (default: 10 minutes)
 * @returns Number of entries removed
 */
export function cleanupExpiredEntries(maxAge = 600_000): number {
  const now = Date.now();
  let removed = 0;

  for (const [key, entry] of store.entries()) {
    // Remove entries that haven't been accessed recently
    const newest = Math.max(...entry.timestamps, 0);
    if (now - newest > maxAge) {
      store.delete(key);
      removed++;
    }
  }

  return removed;
}
