/**
 * Shared credential helpers for the RPC auth middlewares.
 *
 * The per-endpoint authenticators (`authenticate-space.ts` — memory RPC: api key
 * or OAuth token or cookie + X-Me-Space; `authenticate-user.ts` — user RPC: OAuth
 * token or cookie) resolve the credential themselves: an `Authorization: Bearer`
 * token (OAuth access token or api key) via `extractBearerToken`, else the
 * browser cookie session via `betterAuth.api.getSession`. `passesCsrfCheck` gates
 * the ambient (cookie) credential.
 */

/**
 * Extract Bearer token from Authorization header.
 * Returns null if header is missing, malformed, or not Bearer auth.
 *
 * Header-only by design: api-key detection (`authenticate-space.ts`) must never
 * see a cookie, and cookies only ever carry a session token (never an api key).
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

/**
 * CSRF gate for ambient (cookie) credentials. A browser auto-attaches the
 * session cookie, so a cookie-authenticated state-changing request must prove it
 * originates from an allowed origin. Header credentials (Bearer / api key) are
 * exempt — an attacker's page can't set them cross-site.
 *
 * Same-origin requests made by `fetch` carry an `Origin` header; we require it
 * to be in `allowedOrigins`. `Sec-Fetch-Site: same-origin` is accepted as an
 * equivalent positive signal (modern browsers send it and it can't be forged by
 * script). Returns true when the request is allowed.
 */
export function passesCsrfCheck(
  request: Request,
  allowedOrigins: string[],
): boolean {
  const origin = request.headers.get("Origin");
  if (origin && allowedOrigins.includes(origin)) return true;

  if (!origin && request.headers.get("Sec-Fetch-Site") === "same-origin") {
    return true;
  }

  return false;
}
