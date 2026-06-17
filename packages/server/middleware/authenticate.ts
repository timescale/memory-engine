/**
 * Shared credential extraction for the RPC auth middlewares.
 *
 * The per-endpoint authenticators live in `authenticate-space.ts` (memory RPC:
 * session or api key + X-Me-Space) and `authenticate-user.ts` (user RPC:
 * session only). Both resolve the credential via `extractSessionCredential`,
 * which tries the `Authorization: Bearer` header first (a session token *or* an
 * api key, for the CLI / agents) and falls back to the browser session cookie.
 */

import { readSessionCookie } from "../util/cookie";

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

/** Where a resolved credential came from — drives the cookie-only CSRF gate. */
export type CredentialSource = "header" | "cookie";

export interface SessionCredential {
  token: string;
  source: CredentialSource;
}

/**
 * Resolve the request credential: the `Authorization: Bearer` token if present
 * (header — a session token or an api key), else the `me_session` cookie (a
 * session token only). The `source` lets callers apply a CSRF gate to ambient
 * cookie credentials while exempting explicit header credentials.
 */
export function extractSessionCredential(
  request: Request,
): SessionCredential | null {
  const header = extractBearerToken(request);
  if (header) return { token: header, source: "header" };

  const cookie = readSessionCookie(request);
  if (cookie) return { token: cookie, source: "cookie" };

  return null;
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
