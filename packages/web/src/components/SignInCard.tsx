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

  return (
    <div className="flex h-full items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
        <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
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
