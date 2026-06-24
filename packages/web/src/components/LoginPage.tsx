/**
 * OAuth-provider login page — the `loginPage` the better-auth authorize endpoint
 * redirects to.
 *
 * `me login` opens `/api/v1/auth/oauth2/authorize`; with no session, better-auth
 * 302s the browser here with the *signed* authorize params on the query string.
 * We sign the user in, then send them back to the authorize endpoint with those
 * exact params preserved — better-auth re-validates the signature, sees the new
 * session, and (me-cli is a trusted PKCE client with consent skipped) issues the
 * authorization code straight to the CLI's loopback redirect.
 *
 * So the only thing special here vs. the in-app login is the callbackURL: the
 * authorize endpoint + this page's own (signed) query string, verbatim.
 */
import { SignInCard } from "./SignInCard.tsx";

const AUTHORIZE_PATH = "/api/v1/auth/oauth2/authorize";

export function LoginPage() {
  const callbackURL = `${AUTHORIZE_PATH}${window.location.search}`;
  return (
    <SignInCard
      subtitle="Sign in to authorize the Memory Engine CLI."
      callbackURL={callbackURL}
    />
  );
}
