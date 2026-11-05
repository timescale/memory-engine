/**
 * Sign the user in, then return to the OAuth authorization endpoint.
 * The server requires explicit CLI approval after sign-in.
 *
 * Account switching rebuilds the request without the satisfied login prompt.
 * The server adds the consent requirement to this rebuilt request.
 */
import { buildAuthorizeCallbackURL } from "../lib/oauth-callback.ts";
import { clearSignInError } from "../lib/sign-in-error.ts";
import { SignInCard } from "./SignInCard.tsx";

export function LoginPage() {
  const search = clearSignInError(window.location.search);
  const callbackURL = buildAuthorizeCallbackURL(search);
  return (
    <SignInCard
      subtitle="Sign in to authorize the Memory Engine CLI."
      callbackURL={callbackURL}
      errorCallbackURL={`/login${search}`}
    />
  );
}
