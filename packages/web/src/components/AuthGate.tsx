/**
 * Hosted-mode authentication gate.
 *
 * Mounted only in hosted mode (see `main.tsx`); local `me serve` renders the app
 * directly. It probes the session via the user RPC (whoami + space discovery,
 * authenticated by the httpOnly cookie). Not signed in → a login screen that
 * starts the browser OAuth flow. Signed in → a space picker (when needed), then
 * the app — the account/space cluster lives in the app header via the account
 * context this gate provides.
 *
 * The session token never touches JS — login is a full-page redirect to the
 * server, which sets the cookie; logout POSTs to the server, which clears it.
 */

import { isRpcError } from "@memory.build/client";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { signOut } from "../api/auth-client.ts";
import { memoryClient, userClient } from "../api/client.ts";
import { AccountProvider } from "./account/account-context.ts";
import { SignInCard } from "./SignInCard.tsx";

const SPACE_STORAGE_KEY = "me.space";

/**
 * True only for an authentication failure (the user-RPC auth gate returns a 401
 * with app code "UNAUTHORIZED"). Other failures — CSRF/403, 5xx, network — are
 * not fixed by re-login, so they get an error/retry screen instead.
 */
function isAuthFailure(err: unknown): boolean {
  if (!isRpcError(err)) return false;
  return (
    String(err.code) === "UNAUTHORIZED" || err.data?.code === "UNAUTHORIZED"
  );
}

interface Identity {
  email: string;
  name: string;
}

interface Space {
  slug: string;
  name: string;
}

type GateState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "error" }
  | { status: "needs-space"; identity: Identity; spaces: Space[] }
  | { status: "ready"; identity: Identity; spaces: Space[]; space: string };

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const [whoami, { spaces }] = await Promise.all([
        userClient.whoami(),
        userClient.space.list(),
      ]);
      // whoami's email is nullable; fall back to the display name so the
      // header always has something to show.
      const identity: Identity = {
        email: whoami.email ?? whoami.name,
        name: whoami.name,
      };
      if (spaces.length === 0) {
        setState({ status: "needs-space", identity, spaces });
        return;
      }
      const saved = localStorage.getItem(SPACE_STORAGE_KEY);
      const chosen =
        spaces.find((s) => s.slug === saved)?.slug ??
        (spaces.length === 1 ? spaces[0]?.slug : undefined);
      if (chosen) {
        memoryClient.setSpace(chosen);
        setState({ status: "ready", identity, spaces, space: chosen });
      } else {
        setState({ status: "needs-space", identity, spaces });
      }
    } catch (err) {
      // A 401 → not signed in (login screen); anything else (CSRF, 5xx, network)
      // → an error/retry screen, since re-login wouldn't help.
      setState({ status: isAuthFailure(err) ? "anonymous" : "error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const chooseSpace = useCallback((slug: string) => {
    localStorage.setItem(SPACE_STORAGE_KEY, slug);
    memoryClient.setSpace(slug);
    // Reload so the app re-mounts cleanly against the chosen space (avoids
    // cross-space stale query cache).
    window.location.reload();
  }, []);

  const logout = useCallback(async () => {
    try {
      await signOut();
    } finally {
      localStorage.removeItem(SPACE_STORAGE_KEY);
      setState({ status: "anonymous" });
    }
  }, []);

  if (state.status === "loading") {
    return <CenteredMessage>Loading…</CenteredMessage>;
  }

  if (state.status === "anonymous") {
    return <LoginScreen onRetry={load} />;
  }

  if (state.status === "error") {
    return <ErrorScreen onRetry={load} />;
  }

  if (state.status === "needs-space") {
    return (
      <SpacePicker
        identity={state.identity}
        spaces={state.spaces}
        onChoose={chooseSpace}
        onLogout={logout}
      />
    );
  }

  return (
    <AccountProvider
      value={{
        identity: state.identity,
        spaces: state.spaces,
        space: state.space,
        onChooseSpace: chooseSpace,
        onLogout: logout,
      }}
    >
      {children}
    </AccountProvider>
  );
}

function CenteredMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-[13px] text-ink/50">{children}</p>
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-ink/[0.14] bg-white p-8">
        {children}
      </div>
    </div>
  );
}

function LoginScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <SignInCard
      subtitle="Sign in to continue."
      callbackURL={window.location.pathname + window.location.search}
      footer={
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 text-[12px] text-ink/40 hover:text-ink/70"
        >
          Try again
        </button>
      }
    />
  );
}

function ErrorScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <Card>
      <h1 className="text-lg font-semibold text-ink">Something went wrong</h1>
      <p className="mt-1 text-[13px] text-ink/55">
        Couldn't reach Memory Engine. This isn't a sign-in problem — check your
        connection and try again.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 inline-flex h-9 items-center rounded-md bg-solar px-4 text-[13px] font-semibold text-ink transition-colors hover:bg-solar-hover"
      >
        Retry
      </button>
    </Card>
  );
}

function SpacePicker({
  identity,
  spaces,
  onChoose,
  onLogout,
}: {
  identity: Identity;
  spaces: Space[];
  onChoose: (slug: string) => void;
  onLogout: () => void;
}) {
  return (
    <Card>
      <h1 className="text-lg font-semibold text-ink">Choose a space</h1>
      <p className="mt-1 text-[13px] text-ink/55">
        Signed in as {identity.email}
      </p>
      {spaces.length === 0 ? (
        <p className="mt-6 text-[13px] text-ink/55">
          You don't have access to any spaces yet.
        </p>
      ) : (
        <div className="mt-6 flex flex-col gap-2">
          {spaces.map((s) => (
            <button
              key={s.slug}
              type="button"
              onClick={() => onChoose(s.slug)}
              className="rounded-md border border-ink/[0.18] bg-white px-4 py-2 text-left text-[13px] font-medium text-ink transition-colors hover:border-ink"
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={onLogout}
        className="mt-4 text-[12px] text-ink/40 hover:text-ink/70"
      >
        Sign out
      </button>
    </Card>
  );
}
