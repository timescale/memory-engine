/**
 * OAuth-provider login page — the `loginPage` the better-auth authorize endpoint
 * redirects to.
 *
 * `me login` opens `/api/v1/auth/oauth2/authorize`; with no session, better-auth
 * 302s the browser here with the *signed* authorize params on the query string.
 * We sign the user in, then send them back to the authorize endpoint — better-auth
 * sees the new session and (me-cli is a trusted PKCE client with consent skipped)
 * issues the authorization code straight to the CLI's loopback redirect.
 *
 * The one subtlety is the callbackURL — see `buildAuthorizeCallbackURL`: a normal
 * login returns the signed query verbatim, while a `me login --switch` login
 * (which arrives here with `prompt=login`) rebuilds a clean request without
 * `prompt` to avoid an authorize→/login redirect loop.
 */
import { buildAuthorizeCallbackURL } from "../lib/oauth-callback.ts";
import { SignInCard } from "./SignInCard.tsx";

export function LoginPage() {
  const callbackURL = buildAuthorizeCallbackURL(window.location.search);
  return (
    <SignInCard
      subtitle="Sign in to authorize the Memory Engine CLI."
      callbackURL={callbackURL}
    />
  );
}
