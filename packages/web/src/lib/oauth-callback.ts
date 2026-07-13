/**
 * Build the `callbackURL` the `/login` page hands to better-auth social sign-in:
 * where the browser lands once the provider callback sets the session cookie.
 *
 * Normal login (no `prompt`): the better-auth authorize endpoint 302s here with
 * its *signed* query, and we return that query verbatim on `/oauth2/authorize` so
 * the endpoint re-validates the signature and resumes the original request.
 *
 * Switch login (`me login --switch` sends `prompt=login`): the authorize handler
 * redirects to `/login` **every time** the prompt set contains `login` — it only
 * strips a satisfied login prompt inside better-auth's own postLogin continuation,
 * which this custom page bypasses. Returning the signed query (which still carries
 * `prompt=login`) verbatim therefore loops forever: sign in → authorize → back to
 * `/login` → …
 *
 * So for a `login` prompt we rebuild a clean, unsigned authorize request from just
 * the standard OAuth params (dropping `prompt` and better-auth's signing params,
 * since removing `prompt` invalidates the signature). better-auth treats it as a
 * fresh request, sees the freshly-established session, and — `me-cli` being a
 * trusted PKCE client with consent skipped — issues the code straight to the CLI
 * loopback. No loop.
 *
 * Only the `login` prompt is special-cased: it's the sole value the CLI emits and
 * the one that loops through this page. Any other query (no prompt, or a different
 * prompt such as `consent`, which better-auth resolves via its own consent page)
 * is returned verbatim so its signature and intended semantics are preserved.
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

/** OIDC `prompt` is a space-delimited set; true when it contains `login`. */
function promptRequestsLogin(prompt: string | null): boolean {
  return prompt?.split(/\s+/).includes("login") ?? false;
}

/** Prefix a query string onto the authorize path, omitting a bare trailing `?`. */
function withQuery(query: string): string {
  return query ? `${AUTHORIZE_PATH}?${query}` : AUTHORIZE_PATH;
}

/**
 * @param search the `/login` page's `window.location.search` (leading `?` ok).
 */
export function buildAuthorizeCallbackURL(search: string): string {
  const incoming = new URLSearchParams(search);

  // Anything but a `login` prompt (incl. no prompt): return the signed query
  // verbatim so its signature — and any other prompt semantics — survive.
  if (!promptRequestsLogin(incoming.get("prompt"))) {
    return withQuery(search.replace(/^\?/, ""));
  }

  // Switch login: rebuild a clean, unsigned authorize request (no prompt).
  const clean = new URLSearchParams();
  for (const key of OAUTH_PARAM_ALLOWLIST) {
    const value = incoming.get(key);
    if (value !== null) clean.set(key, value);
  }
  return withQuery(clean.toString());
}
