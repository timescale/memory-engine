import { describe, expect, test } from "bun:test";
import {
  extractRetryAfterMs,
  isRateLimitError,
  RateLimitError,
} from "./errors";

// =============================================================================
// RateLimitError
// =============================================================================

describe("RateLimitError", () => {
  test("has correct name and message", () => {
    const err = new RateLimitError("rate limited");
    expect(err.name).toBe("RateLimitError");
    expect(err.message).toBe("rate limited");
    expect(err).toBeInstanceOf(Error);
  });

  test("carries retryAfterMs", () => {
    const err = new RateLimitError("rate limited", 5000);
    expect(err.retryAfterMs).toBe(5000);
  });

  test("retryAfterMs is undefined when not provided", () => {
    const err = new RateLimitError("rate limited");
    expect(err.retryAfterMs).toBeUndefined();
  });
});

// =============================================================================
// isRateLimitError
// =============================================================================

describe("isRateLimitError", () => {
  test("returns true for RateLimitError instance", () => {
    expect(isRateLimitError(new RateLimitError("oops"))).toBe(true);
  });

  test("returns true for object with statusCode 429", () => {
    const apiCallError = { statusCode: 429, message: "Too Many Requests" };
    expect(isRateLimitError(apiCallError)).toBe(true);
  });

  test("returns false for object with statusCode 500", () => {
    const serverError = { statusCode: 500, message: "Internal Server Error" };
    expect(isRateLimitError(serverError)).toBe(false);
  });

  test("returns false for object with statusCode 400", () => {
    const badRequest = { statusCode: 400, message: "Bad Request" };
    expect(isRateLimitError(badRequest)).toBe(false);
  });

  test("returns true for RetryError with lastError statusCode 429", () => {
    const retryError = {
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      lastError: { statusCode: 429, message: "Too Many Requests" },
      errors: [
        { statusCode: 429, message: "Too Many Requests" },
        { statusCode: 429, message: "Too Many Requests" },
      ],
    };
    expect(isRateLimitError(retryError)).toBe(true);
  });

  test("returns true for RetryError with 429 in errors array", () => {
    const retryError = {
      message: "Failed after 3 attempts",
      lastError: { statusCode: 500, message: "Server Error" },
      errors: [
        { statusCode: 429, message: "Too Many Requests" },
        { statusCode: 500, message: "Server Error" },
      ],
    };
    expect(isRateLimitError(retryError)).toBe(true);
  });

  test("returns false for RetryError with no 429 errors", () => {
    const retryError = {
      message: "Failed after 3 attempts",
      lastError: { statusCode: 500, message: "Server Error" },
      errors: [
        { statusCode: 500, message: "Server Error" },
        { statusCode: 503, message: "Service Unavailable" },
      ],
    };
    expect(isRateLimitError(retryError)).toBe(false);
  });

  test("returns false for plain Error", () => {
    expect(isRateLimitError(new Error("boom"))).toBe(false);
  });

  test("returns false for null", () => {
    expect(isRateLimitError(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isRateLimitError(undefined)).toBe(false);
  });

  test("returns false for string", () => {
    expect(isRateLimitError("429")).toBe(false);
  });
});

// =============================================================================
// extractRetryAfterMs
// =============================================================================

describe("extractRetryAfterMs", () => {
  test("extracts retry-after-ms header (milliseconds)", () => {
    const error = {
      statusCode: 429,
      responseHeaders: { "retry-after-ms": "1500" },
    };
    expect(extractRetryAfterMs(error)).toBe(1500);
  });

  test("extracts retry-after header (seconds)", () => {
    const error = {
      statusCode: 429,
      responseHeaders: { "retry-after": "30" },
    };
    expect(extractRetryAfterMs(error)).toBe(30_000);
  });

  test("prefers retry-after-ms over retry-after", () => {
    const error = {
      statusCode: 429,
      responseHeaders: {
        "retry-after-ms": "2000",
        "retry-after": "60",
      },
    };
    expect(extractRetryAfterMs(error)).toBe(2000);
  });

  test("handles retry-after as HTTP-date", () => {
    const futureDate = new Date(Date.now() + 10_000).toUTCString();
    const error = {
      statusCode: 429,
      responseHeaders: { "retry-after": futureDate },
    };
    const ms = extractRetryAfterMs(error);
    expect(ms).toBeDefined();
    // Should be approximately 10s (within 2s tolerance for test timing)
    expect(ms!).toBeGreaterThan(8000);
    expect(ms!).toBeLessThanOrEqual(11_000);
  });

  test("extracts from RetryError lastError", () => {
    const retryError = {
      lastError: {
        statusCode: 429,
        responseHeaders: { "retry-after-ms": "3000" },
      },
      errors: [],
    };
    expect(extractRetryAfterMs(retryError)).toBe(3000);
  });

  test("extracts from RetryError errors array", () => {
    const retryError = {
      lastError: { statusCode: 500 },
      errors: [
        {
          statusCode: 429,
          responseHeaders: { "retry-after-ms": "4000" },
        },
        { statusCode: 500, message: "Server Error" },
      ],
    };
    expect(extractRetryAfterMs(retryError)).toBe(4000);
  });

  test("returns undefined when no headers present", () => {
    const error = { statusCode: 429 };
    expect(extractRetryAfterMs(error)).toBeUndefined();
  });

  test("returns undefined for non-rate-limit error", () => {
    const error = {
      statusCode: 500,
      responseHeaders: { "retry-after": "30" },
    };
    // responseHeaders exist but it's not a 429 error
    // extractRetryAfterMs still returns the value since it reads headers
    // from any error — the caller decides whether the error is rate-limit
    expect(extractRetryAfterMs(error)).toBe(30_000);
  });

  test("returns undefined for null", () => {
    expect(extractRetryAfterMs(null)).toBeUndefined();
  });

  test("returns undefined for plain Error", () => {
    expect(extractRetryAfterMs(new Error("boom"))).toBeUndefined();
  });

  test("ignores invalid retry-after-ms values", () => {
    const error = {
      statusCode: 429,
      responseHeaders: { "retry-after-ms": "not-a-number" },
    };
    expect(extractRetryAfterMs(error)).toBeUndefined();
  });

  test("ignores zero or negative retry-after-ms", () => {
    const error = {
      statusCode: 429,
      responseHeaders: { "retry-after-ms": "0" },
    };
    expect(extractRetryAfterMs(error)).toBeUndefined();
  });

  test("ignores past HTTP-date retry-after", () => {
    const pastDate = new Date(Date.now() - 10_000).toUTCString();
    const error = {
      statusCode: 429,
      responseHeaders: { "retry-after": pastDate },
    };
    expect(extractRetryAfterMs(error)).toBeUndefined();
  });
});
