/**
 * Build the `callbackURL` the `/login` page hands to better-auth social sign-in:
 * where the browser lands once the provider callback sets the session cookie.
 *
 * Normal login (no `prompt`): the better-auth authorize endpoint 302s here with
 * its *signed* query, and we return that query verbatim on `/oauth2/authorize` so
 * the endpoint re-validates the signature and resumes the original request.
 *
 * Switch login (`me login --switch` sends `prompt=login`): the authorize handler
 * redirects to `/login` **every time** `prompt=login` is present — it only strips
 * a satisfied login prompt inside better-auth's own postLogin continuation, which
 * this custom page bypasses. Returning the signed query (which still carries
 * `prompt=login`) verbatim therefore loops forever: sign in → authorize → back to
 * `/login` → …
 *
 * So when `prompt` is present we rebuild a clean, unsigned authorize request from
 * just the standard OAuth params (dropping `prompt` and better-auth's signing
 * params, since removing `prompt` invalidates the signature). better-auth treats
 * it as a fresh request, sees the freshly-established session, and — `me-cli`
 * being a trusted PKCE client with consent skipped — issues the code straight to
 * the CLI loopback. No loop.
 */

const AUTHORIZE_PATH = "/api/v1/auth/oauth2/authorize";

/**
 * The standard OAuth 2.1 authorize params the CLI sends (see
 * `packages/cli/oauth.ts`). Everything else on the `/login` query — `prompt` and
 * better-auth's `exp`/`sig`/issued-at signing params — is dropped when rebuilding
 * a clean request.
 */
const OAUTH_PARAM_ALLOWLIST = [
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
] as const;

/**
 * @param search the `/login` page's `window.location.search` (leading `?` ok).
 */
export function buildAuthorizeCallbackURL(search: string): string {
  const incoming = new URLSearchParams(search);

  // Normal login: no prompt → return the signed query verbatim.
  if (!incoming.has("prompt")) {
    const normalized = search.startsWith("?")
      ? search
      : search
        ? `?${search}`
        : "";
    return `${AUTHORIZE_PATH}${normalized}`;
  }

  // Switch login: rebuild a clean, unsigned authorize request (no prompt).
  const clean = new URLSearchParams();
  for (const key of OAUTH_PARAM_ALLOWLIST) {
    const value = incoming.get(key);
    if (value !== null) clean.set(key, value);
  }
  return `${AUTHORIZE_PATH}?${clean.toString()}`;
}
