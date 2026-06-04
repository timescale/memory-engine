/**
 * Shared bearer-token extraction for the RPC auth middlewares.
 *
 * The per-endpoint authenticators live in `authenticate-space.ts` (memory RPC:
 * session or api key + X-Me-Space) and `authenticate-user.ts` (user RPC:
 * session only). Both resolve the credential from the `Authorization` header
 * via `extractBearerToken`.
 */

/**
 * Extract Bearer token from Authorization header.
 * Returns null if header is missing, malformed, or not Bearer auth.
 */
export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return null;
  }

  const token = parts[1];
  if (!token || token.length === 0) {
    return null;
  }

  return token;
}
