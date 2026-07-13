/**
 * Magic-link redeem landing page (hosted mode), mounted by `main.tsx` for the
 * `/invite/:token` route. It sits outside `AuthGate`: an unauthenticated visitor
 * signs in first (OAuth returns to this same URL), then the token is redeemed and
 * they're dropped into the joined space. Serves both open links and
 * email-constrained links (the email check happens server-side).
 *
 * This route deliberately does NOT run the zero-space `ensureDefault` onboarding
 * — redeeming joins a space, so a magic-link sign-up never gets a junk default.
 */
import { isRpcError } from "@memory.build/client";
import { useCallback, useEffect, useState } from "react";
import { memoryClient, userClient } from "../api/client.ts";
import { SignInCard } from "./SignInCard.tsx";

const SPACE_STORAGE_KEY = "me.space";
const INSTALL_CMD = "curl -fsSL https://install.memory.build | sh";

function isAuthFailure(err: unknown): boolean {
  // `code` is the numeric JSON-RPC code; the string app code lives in `data`
  // (use the RpcError.is helper rather than comparing the number to a string).
  return isRpcError(err) && err.is("UNAUTHORIZED");
}

type State =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "redeeming" }
  | { status: "done"; spaceSlug: string; spaceName: string }
  | { status: "error"; message: string };

export function InviteLandingPage({ token }: { token: string }) {
  const [state, setState] = useState<State>({ status: "loading" });

  const redeem = useCallback(async () => {
    setState({ status: "redeeming" });
    try {
      const { spaceSlug, spaceName } = await userClient.invite.redeem({
        token,
      });
      setState({ status: "done", spaceSlug, spaceName });
    } catch (err) {
      setState({
        status: "error",
        message: isRpcError(err)
          ? err.message
          : "This invite link could not be redeemed.",
      });
    }
  }, [token]);

  const start = useCallback(async () => {
    setState({ status: "loading" });
    try {
      // A session probe: if it succeeds we're signed in and can redeem.
      await userClient.whoami();
      await redeem();
    } catch (err) {
      setState(
        isAuthFailure(err)
          ? { status: "anonymous" }
          : {
              status: "error",
              message: "Couldn't reach Memory Engine. Try again.",
            },
      );
    }
  }, [redeem]);

  useEffect(() => {
    void start();
  }, [start]);

  const enterSpace = (slug: string) => {
    localStorage.setItem(SPACE_STORAGE_KEY, slug);
    memoryClient.setSpace(slug);
    window.location.assign("/");
  };

  if (state.status === "loading" || state.status === "redeeming") {
    return <Centered>Joining…</Centered>;
  }

  if (state.status === "anonymous") {
    // After OAuth the browser returns here (same path), where the effect re-runs
    // and redeems against the now-present session.
    return (
      <SignInCard
        subtitle="Sign in to accept your invitation."
        callbackURL={window.location.pathname + window.location.search}
      />
    );
  }

  if (state.status === "error") {
    return (
      <Card>
        <h1 className="text-lg font-semibold text-ink">Invitation problem</h1>
        <p className="mt-1 text-[13px] text-ink/60">{state.message}</p>
        <button
          type="button"
          onClick={() => window.location.assign("/")}
          className="mt-6 inline-flex h-9 items-center rounded-md border border-ink/[0.18] px-4 text-[13px] font-medium text-ink hover:border-ink"
        >
          Go to Memory Engine
        </button>
      </Card>
    );
  }

  // done
  return (
    <Card>
      <h1 className="text-lg font-semibold text-ink">
        You've joined {state.spaceName}
      </h1>
      <p className="mt-1 text-[13px] text-ink/60">
        Your invitation was accepted.
      </p>

      <div className="mt-6 rounded-lg border border-ink/[0.12] bg-ink/[0.02] p-4">
        <h2 className="text-[13px] font-semibold text-ink">
          Use it from the terminal
        </h2>
        <ol className="mt-3 flex flex-col gap-3">
          <li>
            <div className="text-[12px] text-ink/55">
              <span className="font-semibold text-ink/80">1.</span> Install the{" "}
              <code>me</code> CLI
            </div>
            <CopyBlock text={INSTALL_CMD} />
          </li>
          <li>
            <div className="text-[12px] text-ink/55">
              <span className="font-semibold text-ink/80">2.</span> Then run
              these to sign in and open this space
            </div>
            <CopyBlock text={`me login\nme space use ${state.spaceSlug}`} />
          </li>
        </ol>
      </div>

      <button
        type="button"
        onClick={() => enterSpace(state.spaceSlug)}
        className="mt-6 inline-flex h-9 items-center rounded-md bg-solar px-4 text-[13px] font-semibold text-ink transition-colors hover:bg-solar-hover"
      >
        Continue to the space
      </button>
    </Card>
  );
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1.5 flex items-start gap-2">
      <code className="flex-1 overflow-x-auto whitespace-pre rounded bg-ink/[0.06] px-2 py-1.5 font-mono text-[12px] leading-relaxed text-ink">
        {text}
      </code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="shrink-0 rounded-md border border-ink/[0.18] px-2 py-1 text-[12px] text-ink/70 hover:border-ink"
      >
        {copied ? "Copied" : "Copy"}
      </button>
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
