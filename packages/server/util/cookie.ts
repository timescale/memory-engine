/**
 * Cookie helpers for the browser (hosted-UI) login flow.
 *
 * Two cookies, both httpOnly + SameSite=Lax + Path=/ + host-only:
 * - `me_session` — carries the same opaque session token the CLI uses (a new
 *   transport, not a new credential). High-entropy + hash-validated, so it's not
 *   signed (a tampered value just fails validation).
 * - `me_login` — a short-lived nonce that binds an OAuth callback to the browser
 *   that started the login, so a leaked callback URL can't mint a session in a
 *   different browser.
 *
 * **Name is mode-aware.** Over HTTPS we use the `__Host-` prefix, which the
 * browser only honors when the cookie is `Secure`, `Path=/`, and has no `Domain`
 * — exactly our host-only design, and the strongest prefix. Reads in secure mode
 * accept *only* the `__Host-` name, so a broader-domain (`Domain=.example.com`)
 * `me_session` set by a sibling can't be honored in production. Over plain HTTP
 * (local) `__Host-` can't be set (it requires `Secure`), so we use — and accept
 * — only the unprefixed name.
 */

const SESSION_BASE = "me_session";
const SESSION_HOST = `__Host-${SESSION_BASE}`;
const LOGIN_BASE = "me_login";
const LOGIN_HOST = `__Host-${LOGIN_BASE}`;

/** 7 days — matches the session lifetime (SESSION_EXPIRY_DAYS in auth). */
const SESSION_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;
/** Browser-login nonce TTL — matches BROWSER_LOGIN_STATE_TTL_SECONDS. */
const LOGIN_NONCE_MAX_AGE = 15 * 60;

function nameFor(base: string, hostPrefixed: string, secure: boolean): string {
  return secure ? hostPrefixed : base;
}

function buildCookie(
  name: string,
  value: string,
  secure: boolean,
  maxAge: number,
): string {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

// --- session cookie ---------------------------------------------------------

/** The session cookie name to write/read, given whether the origin is HTTPS. */
export function sessionCookieName(secure: boolean): string {
  return nameFor(SESSION_BASE, SESSION_HOST, secure);
}

/** `Set-Cookie` value that establishes a session. */
export function serializeSessionCookie(token: string, secure: boolean): string {
  return buildCookie(
    sessionCookieName(secure),
    token,
    secure,
    SESSION_COOKIE_MAX_AGE,
  );
}

/**
 * `Set-Cookie` value(s) that clear the session (logout). In secure mode this
 * also clears the unprefixed `me_session` so a stray fallback-named cookie can't
 * outlive logout, even though secure reads ignore it.
 */
export function serializeClearedSessionCookies(secure: boolean): string[] {
  const cleared = [buildCookie(sessionCookieName(secure), "", secure, 0)];
  if (secure) cleared.push(buildCookie(SESSION_BASE, "", false, 0));
  return cleared;
}

/**
 * Read the session token. **Mode-aware:** secure deployments accept only the
 * `__Host-` name; local HTTP accepts only the unprefixed name.
 */
export function readSessionCookie(
  request: Request,
  secure: boolean,
): string | null {
  return readCookie(request, sessionCookieName(secure));
}

// --- login nonce (binds the OAuth callback to the initiating browser) -------

export function loginNonceCookieName(secure: boolean): string {
  return nameFor(LOGIN_BASE, LOGIN_HOST, secure);
}

export function serializeLoginNonceCookie(
  nonce: string,
  secure: boolean,
): string {
  return buildCookie(
    loginNonceCookieName(secure),
    nonce,
    secure,
    LOGIN_NONCE_MAX_AGE,
  );
}

export function serializeClearedLoginNonceCookie(secure: boolean): string {
  return buildCookie(loginNonceCookieName(secure), "", secure, 0);
}

export function readLoginNonceCookie(
  request: Request,
  secure: boolean,
): string | null {
  return readCookie(request, loginNonceCookieName(secure));
}
