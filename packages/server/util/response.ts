/**
 * HTTP response helpers for consistent response formatting.
 */

/**
 * Create a JSON response.
 */
export function json<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
  return new Response(
    JSON.stringify({
      error: { message: "Method Not Allowed", code: "METHOD_NOT_ALLOWED" },
    }),
    {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        Allow: allowed.join(", "),
      },
    },
  );
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
  return new Response(
    JSON.stringify({
      error: { message: "Too Many Requests", code: "RATE_LIMITED" },
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSeconds),
      },
    },
  );
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
