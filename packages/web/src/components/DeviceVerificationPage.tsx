/**
 * Device Authorization Grant verification page (hosted mode), mounted by
 * `main.tsx` for the `/device` route. This is the `verificationUri` the CLI
 * shows when logging in headlessly (`me login --device`): the human opens it in
 * a browser, signs in, and approves the paired `user_code` — after which the
 * CLI's poll of `/device/token` succeeds and it receives a session token.
 *
 * It sits outside `AuthGate`: an unauthenticated visitor signs in first (OAuth
 * returns to this same URL, `user_code` preserved), then the code is claimed and
 * approved. The flow talks directly to better-auth's device-authorization
 * endpoints (same-origin, cookie-authenticated):
 *   - GET  /api/v1/auth/device?user_code=…  → claims the code to this user + status
 *   - POST /api/v1/auth/device/approve      → { userCode }
 *   - POST /api/v1/auth/device/deny         → { userCode }
 */
import { isRpcError } from "@memory.build/client";
import { useCallback, useEffect, useState } from "react";
import { userClient } from "../api/client.ts";
import { Logo } from "./icons.tsx";
import { SignInCard } from "./SignInCard.tsx";

const AUTH_BASE = "/api/v1/auth";

/** Read the `user_code` the CLI put in `verification_uri_complete`, if present. */
function readUserCode(): string {
  return new URLSearchParams(window.location.search).get("user_code") ?? "";
}

function normalizeUserCode(code: string): string {
  return code.trim().toUpperCase();
}

function isAuthFailure(err: unknown): boolean {
  // `code` is the numeric JSON-RPC code; the string app code lives in `data`
  // (use the RpcError.is helper rather than comparing the number to a string).
  return isRpcError(err) && err.is("UNAUTHORIZED");
}

/**
 * Call a better-auth device endpoint same-origin (the session cookie rides
 * along). better-auth returns `{ error, error_description }` with a non-2xx
 * status on failure — surface the human-readable description.
 */
async function deviceCall<T>(path: string, init?: RequestInit): Promise<T> {
  // Normalize through Headers (init.headers is a HeadersInit union — spreading
  // it silently drops entries when it's a Headers/array), then default the type.
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${AUTH_BASE}${path}`, {
    credentials: "include",
    ...init,
    headers,
  });
  const body = (await res.json().catch(() => ({}))) as {
    error_description?: string;
    message?: string;
  } & T;
  if (!res.ok) {
    throw new Error(
      body?.error_description ??
        body?.message ??
        "The verification request failed. The code may have expired.",
    );
  }
  return body as T;
}

type State =
  | { status: "checking" }
  | { status: "anonymous" }
  | { status: "needCode"; email: string | null }
  | { status: "ready"; userCode: string; email: string | null }
  | { status: "submitting"; userCode: string; email: string | null }
  | { status: "approved" }
  | { status: "denied" }
  | { status: "error"; message: string };

export function DeviceVerificationPage() {
  const [state, setState] = useState<State>({ status: "checking" });
  const [codeInput, setCodeInput] = useState(readUserCode);

  // Claim a user code against the current session and read its status. Called
  // once the visitor is known to be signed in.
  const claim = useCallback(async (userCode: string, email: string | null) => {
    const code = normalizeUserCode(userCode);
    if (!code) {
      setState({ status: "needCode", email });
      return;
    }
    setState({ status: "checking" });
    try {
      const { status } = await deviceCall<{ status: string }>(
        `/device?user_code=${encodeURIComponent(code)}`,
        { method: "GET" },
      );
      if (status === "approved") {
        setState({ status: "approved" });
      } else if (status === "denied") {
        setState({ status: "denied" });
      } else {
        setState({ status: "ready", userCode: code, email });
      }
    } catch (err) {
      setState({
        status: "error",
        message:
          err instanceof Error
            ? err.message
            : "This code could not be verified.",
      });
    }
  }, []);

  // On mount: confirm a session (whoami), then claim the code from the URL (if
  // any). Anonymous visitors are sent through sign-in first.
  const start = useCallback(async () => {
    setState({ status: "checking" });
    try {
      const me = await userClient.whoami();
      await claim(readUserCode(), me.email);
    } catch (err) {
      if (isAuthFailure(err)) {
        setState({ status: "anonymous" });
      } else {
        setState({
          status: "error",
          message: "Couldn't reach Memory Engine. Try again.",
        });
      }
    }
  }, [claim]);

  useEffect(() => {
    void start();
  }, [start]);

  const decide = async (
    approve: boolean,
    userCode: string,
    email: string | null,
  ) => {
    setState({ status: "submitting", userCode, email });
    try {
      await deviceCall(`/device/${approve ? "approve" : "deny"}`, {
        method: "POST",
        body: JSON.stringify({ userCode }),
      });
      setState({ status: approve ? "approved" : "denied" });
    } catch (err) {
      setState({
        status: "error",
        message:
          err instanceof Error
            ? err.message
            : "The request could not be completed.",
      });
    }
  };

  if (state.status === "checking") {
    return <Centered>Verifying…</Centered>;
  }

  if (state.status === "anonymous") {
    // After OAuth the browser returns here (same path + user_code), the effect
    // re-runs, and the now-present session lets us claim the code. When a code
    // is present, frame the whole card as "authorize THIS code" (title + a code
    // banner) so the provider choice reads as a step toward that, not a bare
    // login. A bare /device visit keeps the generic card (the code is entered
    // after sign-in via the needCode step).
    const pendingCode = normalizeUserCode(readUserCode());
    const deviceCallbackURL = window.location.pathname + window.location.search;
    return (
      <SignInCard
        title={pendingCode ? "Authorize a device" : undefined}
        subtitle={
          pendingCode
            ? "Sign in to authorize this device for the Memory Engine CLI."
            : "Sign in to authorize a device for the Memory Engine CLI."
        }
        banner={
          pendingCode ? (
            <div className="mt-5">
              <CodeBox code={pendingCode} />
            </div>
          ) : undefined
        }
        callbackURL={deviceCallbackURL}
        errorCallbackURL={deviceCallbackURL}
      />
    );
  }

  if (state.status === "needCode") {
    return (
      <Card>
        <Heading>Authorize a device</Heading>
        <p className="mt-3 text-[13px] text-ink/55">
          Enter the code shown in your terminal to continue.
        </p>
        <form
          className="mt-6 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void claim(codeInput, state.email);
          }}
        >
          <input
            type="text"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            aria-label="Device code"
            placeholder="XXXX-XXXX"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="h-10 rounded-lg border border-ink/[0.18] px-3 text-center font-mono text-[15px] tracking-[0.2em] text-ink uppercase focus:border-ink focus:outline-none"
          />
          <button
            type="submit"
            disabled={!codeInput.trim()}
            className="inline-flex h-10 items-center justify-center rounded-lg bg-solar text-[13px] font-semibold text-ink transition-colors hover:bg-solar-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Continue
          </button>
        </form>
      </Card>
    );
  }

  if (state.status === "ready" || state.status === "submitting") {
    const busy = state.status === "submitting";
    return (
      <Card>
        <Heading>Authorize this device?</Heading>
        <p className="mt-3 text-[13px] text-ink/55">
          A device is requesting access to your Memory Engine account
          {state.email ? (
            <>
              {" "}
              as <span className="font-medium text-ink/80">{state.email}</span>
            </>
          ) : null}
          . Only approve if you started a{" "}
          <code className="rounded bg-ink/[0.06] px-1 py-0.5 font-mono text-[12px]">
            me login
          </code>{" "}
          in a terminal.
        </p>

        <div className="mt-5">
          <CodeBox code={state.userCode} />
        </div>

        <div className="mt-6 flex gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide(true, state.userCode, state.email)}
            className="inline-flex h-10 flex-1 items-center justify-center rounded-lg bg-solar text-[13px] font-semibold text-ink transition-colors hover:bg-solar-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Authorizing…" : "Approve"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide(false, state.userCode, state.email)}
            className="inline-flex h-10 flex-1 items-center justify-center rounded-lg border border-ink/[0.18] text-[13px] font-medium text-ink transition-colors hover:border-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            Deny
          </button>
        </div>
      </Card>
    );
  }

  if (state.status === "approved") {
    return (
      <Card>
        <Heading>Device approved</Heading>
        <p className="mt-3 text-[13px] text-ink/60">
          You're all set — return to your terminal to finish signing in. You can
          close this tab.
        </p>
      </Card>
    );
  }

  if (state.status === "denied") {
    return (
      <Card>
        <Heading>Device denied</Heading>
        <p className="mt-3 text-[13px] text-ink/60">
          The request was rejected. No device was granted access. You can close
          this tab.
        </p>
      </Card>
    );
  }

  // error
  return (
    <Card>
      <Heading>Verification problem</Heading>
      <p className="mt-3 text-[13px] text-ink/60">{state.message}</p>
      <button
        type="button"
        onClick={() => window.location.assign("/device")}
        className="mt-6 inline-flex h-9 items-center rounded-md border border-ink/[0.18] px-4 text-[13px] font-medium text-ink hover:border-ink"
      >
        Try another code
      </button>
    </Card>
  );
}

/** The user code, boxed — shown on the sign-in banner and the approve screen. */
function CodeBox({ code }: { code: string }) {
  return (
    <div className="rounded-lg border border-ink/[0.12] bg-ink/[0.02] px-4 py-3 text-center">
      <div className="text-[11px] uppercase tracking-wide text-ink/45">
        Code
      </div>
      <div className="mt-1 font-mono text-[18px] tracking-[0.2em] text-ink">
        {code}
      </div>
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-[11px]">
      <Logo />
      <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
        {children}
      </h1>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-[13px] text-ink/50">{children}</p>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-ink/[0.14] bg-white p-8">
        {children}
      </div>
    </div>
  );
}
