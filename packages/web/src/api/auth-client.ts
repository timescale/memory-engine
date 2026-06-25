/**
 * better-auth browser client (hosted mode).
 *
 * Owns the auth *actions* — social sign-in + sign-out — against the same-origin
 * auth server (basePath `/api/v1/auth`). Session *state* is read separately via
 * the user RPC (whoami) in `AuthGate`, since that's also what triggers core
 * provisioning + space discovery.
 *
 * The custom basePath means `baseURL` must include the full auth path (the
 * client appends `/sign-in/social`, `/sign-out`, … to it). Same-origin, so the
 * session cookie rides along automatically.
 */
import { createAuthClient } from "better-auth/react";

export type SocialProvider = "github" | "google";

export const authClient = createAuthClient({
  baseURL: `${window.location.origin}/api/v1/auth`,
});

/**
 * Start social sign-in. The client redirects the browser to the provider; after
 * the callback sets the session cookie, the browser lands on `callbackURL`.
 *
 * `callbackURL` decides where the flow resumes:
 *   - in-app login → back into the app (the current URL)
 *   - the OAuth-provider `/login` page → the authorize endpoint, with the signed
 *     authorize params preserved, so the CLI loopback flow continues to a code.
 */
export async function signInWithProvider(
  provider: SocialProvider,
  callbackURL: string,
  errorCallbackURL?: string,
): Promise<void> {
  // `errorCallbackURL` is where the social flow redirects on failure (e.g. the
  // server's verified-email login gate throws → better-auth appends
  // `?error=…&error_description=…`). Default to the current page so the error
  // surfaces in-place rather than on better-auth's bare `/error`.
  await authClient.signIn.social({
    provider,
    callbackURL,
    errorCallbackURL: errorCallbackURL ?? window.location.pathname,
  });
}

/** Clear the session cookie (server-side) + return. */
export async function signOut(): Promise<void> {
  await authClient.signOut();
}
