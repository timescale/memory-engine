import { payloadTooLarge } from "../util/response";

/**
 * Maximum request body size in bytes (1MB).
 */
export const MAX_BODY_SIZE = 1_048_576;

/**
 * Middleware to reject requests larger than the size limit.
 * Checks Content-Length header before reading body.
 *
 * @returns null if request is within limit, 413 response if too large
 */
export function checkSizeLimit(request: Request): Response | null {
  const contentLength = request.headers.get("Content-Length");

  if (contentLength) {
    const size = Number.parseInt(contentLength, 10);
    if (!Number.isNaN(size) && size > MAX_BODY_SIZE) {
      return payloadTooLarge(
        `Request body too large. Maximum size is ${MAX_BODY_SIZE} bytes.`,
      );
    }
  }

  return null;
}
