import { useEffect, useRef, useState } from "react";
import {
  type CliConsentDetails,
  loadCliConsentDetails,
  submitCliConsent,
} from "../lib/cli-consent.ts";
import { Logo } from "./icons.tsx";

export type CliConsentState =
  | { status: "loading" }
  | { status: "ready" | "submitting"; details: CliConsentDetails }
  | { status: "error"; message: string };

export function CliConsentPage() {
  const [oauthQuery] = useState(() =>
    window.location.search.replace(/^\?/, ""),
  );
  const [state, setState] = useState<CliConsentState>({ status: "loading" });
  const submitted = useRef(false);

  useEffect(() => {
    let active = true;
    void loadCliConsentDetails(oauthQuery).then(
      (details) => {
        if (active) setState({ status: "ready", details });
      },
      (error: unknown) => {
        if (active) {
          setState({ status: "error", message: errorMessage(error) });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [oauthQuery]);

  const decide = async (accept: boolean) => {
    if (state.status !== "ready" || submitted.current) return;
    submitted.current = true;
    setState({ status: "submitting", details: state.details });
    try {
      const callback = await submitCliConsent(
        accept,
        oauthQuery,
        state.details,
      );
      window.location.assign(callback);
    } catch (error) {
      setState({ status: "error", message: errorMessage(error) });
    }
  };

  return (
    <CliConsentView state={state} onDecide={(accept) => void decide(accept)} />
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "This request could not be completed. Run me login again.";
}

export function CliConsentView({
  state,
  onDecide,
}: {
  state: CliConsentState;
  onDecide: (accept: boolean) => void;
}) {
  const details =
    state.status === "ready" || state.status === "submitting"
      ? state.details
      : null;
  const busy = state.status === "submitting";

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-ink/[0.14] bg-surface p-8">
        <div className="flex items-center gap-[11px]">
          <Logo />
          <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
            Authorize CLI access
          </h1>
        </div>
        {state.status === "loading" ? (
          <p role="status" className="mt-3 text-[13px] text-ink/60">
            Verifying authorization request…
          </p>
        ) : state.status === "error" ? (
          <div role="alert" className="mt-3 text-[13px] text-ink/60">
            <p>{state.message}</p>
            <p className="mt-3">
              Do not reuse this link. Return to your terminal and run{" "}
              <code>me login</code> again.
            </p>
          </div>
        ) : details ? (
          <>
            <dl className="mt-5 space-y-3 text-[13px] text-ink/60">
              <div>
                <dt className="font-medium text-ink">Account</dt>
                <dd className="break-all">{details.user.email}</dd>
              </div>
              <div>
                <dt className="font-medium text-ink">Application</dt>
                <dd className="break-words">{details.clientName}</dd>
              </div>
            </dl>
            <p className="mt-3 text-[13px] text-ink/60">
              This application claims to be the Memory Engine CLI. This does not
              verify the identity of the program running on your computer.
            </p>
            <div className="mt-4 text-[13px] text-ink/60">
              <h2 className="font-medium text-ink">Permissions</h2>
              <p className="mt-1">
                The CLI will act as this account. It can read and change
                memories, manage spaces, and manage access where your existing
                space memberships and permissions allow. This does not grant new
                permissions.
              </p>
              <ul className="mt-2 list-inside list-disc break-words font-mono text-[12px]">
                {details.scopes.map((scope) => (
                  <li key={scope}>{scope}</li>
                ))}
              </ul>
              {details.scopes.includes("offline_access") ? (
                <p className="mt-2">
                  Offline access: the CLI can refresh its credentials and
                  continue to access your account when you are not using this
                  browser.
                </p>
              ) : null}
            </div>
            <div className="mt-4 text-[13px] text-ink/60">
              <h2 className="font-medium text-ink">Callback address</h2>
              <code className="mt-2 block break-all rounded-lg border border-ink/[0.12] bg-ink/[0.02] px-3 py-2 text-[12px] text-ink">
                {details.redirectUri}
              </code>
              <p className="mt-2">
                Compare this full address, including the port and path, with the
                callback address in your terminal. They must match exactly.
              </p>
            </div>
            <p className="mt-4 text-[13px] font-medium text-ink">
              Only authorize if you just ran <code>me login</code> yourself. If
              someone sent you this link or the address does not match, cancel.
              Approval gives the requesting program access to your account.
            </p>
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => onDecide(false)}
                className="inline-flex h-10 flex-1 items-center justify-center rounded-lg border border-ink/[0.18] text-[13px] font-medium text-ink transition-colors hover:border-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onDecide(true)}
                className="inline-flex h-10 flex-1 items-center justify-center rounded-lg bg-solar text-[13px] font-semibold text-solar-ink transition-colors hover:bg-solar-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                Authorize CLI
              </button>
            </div>
            {busy ? (
              <p role="status" className="mt-3 text-[13px] text-ink/60">
                Submitting your decision…
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
