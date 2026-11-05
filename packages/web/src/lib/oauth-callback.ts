/**
 * Build the browser destination after social sign-in.
 * Ordinary GET authorization requests do not require a signature.
 * The server adds the consent requirement to every new CLI authorization.
 *
 * Preserve the incoming query unless it contains a login prompt. That prompt
 * would send the browser back to the login page after sign-in. For account
 * switching, keep the standard OAuth parameters and remove the satisfied login
 * prompt and obsolete signing parameters. The server then requires approval.
 *
 * Native consent submissions use the original signed oauth_query instead.
 * The provider verifies that envelope before it completes approval.
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

  // Preserve other prompts. The server still requires approval.
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
