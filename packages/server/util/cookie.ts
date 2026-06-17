/**
 * Session cookie helpers for the browser (hosted-UI) login flow.
 *
 * The browser holds the same opaque session token the CLI uses, but carried in
 * an httpOnly cookie instead of an `Authorization` header — a new transport, not
 * a new credential. The token is high-entropy and validated by hash lookup, so
 * the cookie is not signed (a tampered value just fails validation).
 *
 * Cookie name: in production (HTTPS) we use the `__Host-` prefix, which the
 * browser only honors when the cookie is `Secure`, `Path=/`, and has no `Domain`
 * — exactly our host-only design, and the strongest prefix (better-auth uses
 * `__Secure-`/`__Host-`). Over plain HTTP (local runs) `__Host-` can't be set
 * (it requires `Secure`), so we fall back to the unprefixed name.
 */

const COOKIE_BASE = "me_session";
const COOKIE_HOST_PREFIXED = `__Host-${COOKIE_BASE}`;

/** 7 days — matches the session lifetime (SESSION_EXPIRY_DAYS in auth). */
const SESSION_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

/** The cookie name to write, given whether the public origin is HTTPS. */
export function sessionCookieName(secure: boolean): string {
  return secure ? COOKIE_HOST_PREFIXED : COOKIE_BASE;
}

/** Serialize the `Set-Cookie` value that establishes a session. */
export function serializeSessionCookie(token: string, secure: boolean): string {
  const parts = [
    `${sessionCookieName(secure)}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_COOKIE_MAX_AGE}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Serialize the `Set-Cookie` value that clears the session (logout). */
export function serializeClearedSessionCookie(secure: boolean): string {
  const parts = [
    `${sessionCookieName(secure)}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Read the session token from a request's `Cookie` header. Accepts either the
 * `__Host-`prefixed (production) or unprefixed (local) name, so the same reader
 * works regardless of how the cookie was set.
 */
export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === COOKIE_HOST_PREFIXED || name === COOKIE_BASE) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}
