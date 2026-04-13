// =============================================================================
// Rate Limit Error
// =============================================================================

/**
 * Thrown when an embedding API call fails due to rate limiting (HTTP 429).
 *
 * Carries the optional `retryAfterMs` from the provider's Retry-After header
 * so callers can back off appropriately.
 */
export class RateLimitError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

// =============================================================================
// Detection Helpers
// =============================================================================

/**
 * Check if an error (or any error in a retry chain) originated from HTTP 429.
 *
 * Handles two shapes:
 * - `APICallError` from `@ai-sdk/provider` with `statusCode: 429`
 * - `RetryError` from `ai` SDK wrapping an inner `APICallError` via `lastError`
 */
export function isRateLimitError(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;

  // Direct APICallError with statusCode 429
  if (hasStatusCode(error, 429)) return true;

  // RetryError wrapping a 429 as lastError
  if (hasLastError(error) && isRateLimitError(error.lastError)) {
    return true;
  }

  // RetryError with errors array — check all inner errors
  if (hasErrors(error)) {
    return error.errors.some((inner: unknown) => hasStatusCode(inner, 429));
  }

  return false;
}

/**
 * Extract `retryAfterMs` from the response headers of a rate-limit error.
 *
 * Looks for `retry-after-ms` (milliseconds) or `retry-after` (seconds or
 * HTTP-date) on the inner `APICallError`'s `responseHeaders`.
 */
export function extractRetryAfterMs(error: unknown): number | undefined {
  const headers = getResponseHeaders(error);
  if (!headers) return undefined;

  // retry-after-ms (milliseconds, used by OpenAI)
  const retryAfterMs = headers["retry-after-ms"];
  if (retryAfterMs) {
    const ms = Number.parseFloat(retryAfterMs);
    if (!Number.isNaN(ms) && ms > 0) return ms;
  }

  // retry-after (seconds or HTTP-date)
  const retryAfter = headers["retry-after"];
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;

    // HTTP-date format
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      const ms = date - Date.now();
      if (ms > 0) return ms;
    }
  }

  return undefined;
}

// =============================================================================
// Type Narrowing Helpers
// =============================================================================

/** Check for an object with `statusCode` matching the expected value. */
function hasStatusCode(
  error: unknown,
  expected: number,
): error is { statusCode: number } {
  return (
    error != null &&
    typeof error === "object" &&
    "statusCode" in error &&
    (error as { statusCode: unknown }).statusCode === expected
  );
}

/** Check for a RetryError-like object with `lastError`. */
function hasLastError(error: unknown): error is { lastError: unknown } {
  return error != null && typeof error === "object" && "lastError" in error;
}

/** Check for a RetryError-like object with `errors` array. */
function hasErrors(error: unknown): error is { errors: unknown[] } {
  return (
    error != null &&
    typeof error === "object" &&
    "errors" in error &&
    Array.isArray((error as { errors: unknown }).errors)
  );
}

/**
 * Walk the error chain to find responseHeaders from an APICallError.
 *
 * Checks the error itself, then `lastError` (RetryError), then each entry
 * in `errors[]`.
 */
function getResponseHeaders(
  error: unknown,
): Record<string, string> | undefined {
  // Direct APICallError
  if (hasResponseHeaders(error)) return error.responseHeaders;

  // RetryError → lastError
  if (hasLastError(error) && hasResponseHeaders(error.lastError)) {
    return error.lastError.responseHeaders;
  }

  // RetryError → errors array (find the 429)
  if (hasErrors(error)) {
    for (const inner of error.errors) {
      if (hasStatusCode(inner, 429) && hasResponseHeaders(inner)) {
        return inner.responseHeaders;
      }
    }
  }

  return undefined;
}

/** Check for an object with a `responseHeaders` record. */
function hasResponseHeaders(
  error: unknown,
): error is { responseHeaders: Record<string, string> } {
  return (
    error != null &&
    typeof error === "object" &&
    "responseHeaders" in error &&
    (error as { responseHeaders: unknown }).responseHeaders != null &&
    typeof (error as { responseHeaders: unknown }).responseHeaders === "object"
  );
}
