import { Buffer } from "node:buffer";
import { type Histogram, metrics } from "@opentelemetry/api";

/** Numeric-only metadata: never retain a second payload or consume the body. */
export interface JsonResponseTelemetry {
  "http.response.body.size": number;
  "response.serialization.duration_ms": number;
}
const responseTelemetry = new WeakMap<Response, JsonResponseTelemetry>();

export function jsonResponseTelemetry(
  response: Response,
): JsonResponseTelemetry | undefined {
  return responseTelemetry.get(response);
}

let serializationDuration: Histogram | undefined;
let responseBytes: Histogram | undefined;

/** Best effort only; the global meter is the existing Logfire provider. */
function recordSerialization(bytes: number, durationMs: number): void {
  try {
    const meter = metrics.getMeter("memory-engine.http");
    serializationDuration ??= meter.createHistogram(
      "memory_engine.http.response.serialization.duration",
      {
        unit: "ms",
        description: "JSON.stringify duration for JSON response helpers",
      },
    );
    serializationDuration.record(durationMs);
    responseBytes ??= meter.createHistogram(
      "memory_engine.http.response.body.size",
      {
        unit: "By",
        description: "UTF-8 JSON response bytes (not network-flush bytes)",
        advice: {
          // OTel's default buckets stop at 10 KB, hiding the large responses
          // this instrumentation is meant to diagnose. Extend through 64 MiB.
          explicitBucketBoundaries: [
            0, 1024, 4096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304,
            16_777_216, 67_108_864,
          ],
        },
      },
    );
    responseBytes.record(bytes);
  } catch {
    // Exporter/instrumentation failures must not affect a response.
  }
}

/** HTTP response helpers for consistent response formatting. */

/**
 * Create a JSON response.
 */
export function json<T>(data: T, status = 200): Response {
  const started = performance.now();
  const body = JSON.stringify(data);
  const durationMs = performance.now() - started;
  const response = new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
  try {
    const bytes = body === undefined ? 0 : Buffer.byteLength(body, "utf8");
    responseTelemetry.set(response, {
      "http.response.body.size": bytes,
      "response.serialization.duration_ms": durationMs,
    });
    recordSerialization(bytes, durationMs);
  } catch {
    // Measurement is fail-open; serialization/Response errors still propagate.
  }
  return response;
}

/**
 * Create a plain text response.
 */
export function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

/** Default CSP for HTML pages that don't submit forms to external origins. */
const DEFAULT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'";

/**
 * Create an HTML response with security headers.
 *
 * Pass a custom `csp` to override the default Content-Security-Policy
 * (e.g. for pages whose forms redirect to external OAuth providers).
 */
export function html(body: string, status = 200, csp = DEFAULT_CSP): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

/**
 * Create a redirect (302 by default). Pass `setCookie` to attach a `Set-Cookie`
 * header (used by the browser-login callback / logout to manage the session
 * cookie on the redirect response).
 */
export function redirect(
  location: string,
  opts: { status?: number; setCookie?: string | string[] } = {},
): Response {
  const headers = new Headers({ Location: location });
  if (opts.setCookie) {
    const cookies = Array.isArray(opts.setCookie)
      ? opts.setCookie
      : [opts.setCookie];
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  }
  return new Response(null, { status: opts.status ?? 302, headers });
}

/**
 * Create an error response with JSON body.
 */
export function error(
  message: string,
  status: number,
  code?: string,
): Response {
  return json({ error: { message, code } }, status);
}

/**
 * 404 Not Found response.
 */
export function notFound(message = "Not Found"): Response {
  return error(message, 404, "NOT_FOUND");
}

/**
 * 405 Method Not Allowed response.
 */
export function methodNotAllowed(allowed: string[]): Response {
  const response = json(
    { error: { message: "Method Not Allowed", code: "METHOD_NOT_ALLOWED" } },
    405,
  );
  response.headers.set("Allow", allowed.join(", "));
  return response;
}

/**
 * 413 Payload Too Large response.
 */
export function payloadTooLarge(message = "Payload Too Large"): Response {
  return error(message, 413, "PAYLOAD_TOO_LARGE");
}

/**
 * 429 Too Many Requests response.
 */
export function tooManyRequests(retryAfterSeconds: number): Response {
  const response = json(
    { error: { message: "Too Many Requests", code: "RATE_LIMITED" } },
    429,
  );
  response.headers.set("Retry-After", String(retryAfterSeconds));
  return response;
}

/**
 * 401 Unauthorized response.
 */
export function unauthorized(message = "Unauthorized"): Response {
  return error(message, 401, "UNAUTHORIZED");
}

/**
 * 403 Forbidden response.
 */
export function forbidden(message = "Forbidden"): Response {
  return error(message, 403, "FORBIDDEN");
}

/**
 * 500 Internal Server Error response.
 */
export function internalError(message = "Internal Server Error"): Response {
  return error(message, 500, "INTERNAL_ERROR");
}
