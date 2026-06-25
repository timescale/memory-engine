/**
 * Shared social sign-in card.
 *
 * Renders the GitHub/Google buttons and drives better-auth social sign-in
 * (see `auth-client.ts`). The only thing that varies between callers is
 * `callbackURL` — where the browser lands once the session cookie is set:
 *   - in-app login (`AuthGate`) → back into the app
 *   - the `/login` page (`LoginPage`) → the OAuth authorize endpoint, resuming
 *     the CLI loopback flow.
 */
import type { ReactNode } from "react";
import { type SocialProvider, signInWithProvider } from "../api/auth-client.ts";

/**
 * A failed social sign-in redirects back here with `?error[&error_description]`
 * (see `auth-client.ts`). Surface the human message — notably the server's
 * verified-email login gate (`EMAIL_NOT_VERIFIED`).
 */
function readSignInError(): string | null {
  const params = new URLSearchParams(window.location.search);
  const description = params.get("error_description");
  if (description) return description;
  const code = params.get("error");
  if (!code) return null;
  return code === "EMAIL_NOT_VERIFIED"
    ? "Your email is not verified with your identity provider. Verify it with GitHub or Google, then sign in again."
    : "Sign-in failed. Please try again.";
}

export function SignInCard({
  title = "Memory Engine",
  subtitle,
  callbackURL,
  footer,
}: {
  title?: string;
  subtitle: string;
  callbackURL: string;
  footer?: ReactNode;
}) {
  const start = (provider: SocialProvider) => {
    // The SDK redirects the browser to the provider; a failure (network/CSRF)
    // leaves us here to retry.
    void signInWithProvider(provider, callbackURL).catch((err) => {
      console.error("[me] social sign-in failed", err);
    });
  };

  const signInError = readSignInError();

  return (
    <div className="flex h-full items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
        <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
        {signInError && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {signInError}
          </div>
        )}
        <div className="mt-6 flex flex-col gap-3">
          <button
            type="button"
            onClick={() => start("github")}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Sign in with GitHub
          </button>
          <button
            type="button"
            onClick={() => start("google")}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
          >
            Sign in with Google
          </button>
        </div>
        {footer}
      </div>
    </div>
  );
}
