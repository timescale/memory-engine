/** Minimum backoff when rate limited, even if Retry-After is shorter. */
export const RATE_LIMIT_FLOOR_MS = 30_000;

/**
 * The backoff to wait after a provider rate limit (HTTP 429).
 *
 * Honors the provider's Retry-After (`retryAfterMs`) when present, floored at
 * RATE_LIMIT_FLOOR_MS so a short or absent header can't make the pool hammer
 * the provider every poll. This is the single source of truth shared by the
 * worker loop's sleep and `release_embedding`'s visibility deferral, so a
 * released row reappears exactly when the worker is ready to retry it — not
 * before (which would let another worker re-claim it mid-backoff).
 */
export function rateLimitBackoffMs(retryAfterMs?: number): number {
  return Math.max(retryAfterMs ?? RATE_LIMIT_FLOOR_MS, RATE_LIMIT_FLOOR_MS);
}
