import { payloadTooLarge } from "../util/response";

/** Default maximum request body size in bytes (1 MiB). */
export const DEFAULT_MAX_BODY_SIZE = 1_048_576;

/**
 * Resolve the request body size cap from the environment.
 *
 * Reads `MAX_REQUEST_BODY_BYTES`. Returns the default when the variable
 * is unset or empty. Throws on a non-numeric or non-positive value
 * (better to fail loudly at startup than silently fall back).
 *
 * Exported separately so the resolution logic can be unit-tested by
 * passing an explicit env object — `MAX_BODY_SIZE` itself is captured
 * once at module load.
 */
export function resolveMaxBodySize(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.MAX_REQUEST_BODY_BYTES;
  if (raw === undefined || raw === "") return DEFAULT_MAX_BODY_SIZE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `MAX_REQUEST_BODY_BYTES must be a positive number, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

/**
 * Maximum request body size, resolved once at module load. Set
 * `MAX_REQUEST_BODY_BYTES` to override; defaults to 1 MiB.
 */
export const MAX_BODY_SIZE = resolveMaxBodySize();

/**
 * Middleware to reject requests larger than the size limit.
 * Checks Content-Length header before reading body.
 *
 * @param request - incoming request
 * @param limit   - byte ceiling; defaults to the module's resolved
 *                  `MAX_BODY_SIZE`. Override only for tests that need
 *                  to exercise a specific limit without touching env.
 * @returns null if request is within limit, 413 response if too large
 */
export function checkSizeLimit(
  request: Request,
  limit: number = MAX_BODY_SIZE,
): Response | null {
  const contentLength = request.headers.get("Content-Length");

  if (contentLength) {
    const size = Number.parseInt(contentLength, 10);
    if (!Number.isNaN(size) && size > limit) {
      return payloadTooLarge(
        `Request body too large. Maximum size is ${limit} bytes.`,
      );
    }
  }

  return null;
}
