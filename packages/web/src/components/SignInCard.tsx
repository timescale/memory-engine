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
import { Logo } from "./icons.tsx";

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
  errorCallbackURL,
  banner,
  footer,
}: {
  title?: string;
  subtitle: string;
  callbackURL: string;
  errorCallbackURL?: string;
  /** Optional content rendered between the subtitle and the sign-in buttons. */
  banner?: ReactNode;
  footer?: ReactNode;
}) {
  const start = (provider: SocialProvider) => {
    // The SDK redirects the browser to the provider; a failure (network/CSRF)
    // leaves us here to retry.
    void signInWithProvider(provider, callbackURL, errorCallbackURL).catch(
      (err) => {
        console.error("[me] social sign-in failed", err);
      },
    );
  };

  const signInError = readSignInError();

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-ink/[0.14] bg-surface p-8">
        <div className="flex items-center gap-[11px]">
          <Logo />
          <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
            {title}
          </h1>
        </div>
        <p className="mt-3 text-[13px] text-ink/55">{subtitle}</p>
        {banner}
        {signInError && (
          <div className="mt-4 rounded-md border border-tiger-red/50 bg-tiger-red/10 px-3 py-2 text-[13px] text-ink/80">
            {signInError}
          </div>
        )}
        <div className="mt-6 flex flex-col gap-3">
          <button
            type="button"
            onClick={() => start("github")}
            className="inline-flex h-10 items-center justify-center rounded-lg bg-solar text-[13px] font-semibold text-solar-ink transition-colors hover:bg-solar-hover"
          >
            Sign in with GitHub
          </button>
          <button
            type="button"
            onClick={() => start("google")}
            className="inline-flex h-10 items-center justify-center rounded-lg border border-ink/[0.18] text-[13px] font-medium text-ink transition-colors hover:border-ink"
          >
            Sign in with Google
          </button>
        </div>
        {footer}
      </div>
    </div>
  );
}
