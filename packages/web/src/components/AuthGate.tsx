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
import {
  type AccountInvitation,
  AccountProvider,
} from "./account/account-context.ts";
import { InvitationList } from "./account/Invitations.tsx";
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
  admin: boolean;
}

type GateState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "error" }
  | {
      status: "onboarding";
      identity: Identity;
      invitations: AccountInvitation[];
    }
  | {
      status: "needs-space";
      identity: Identity;
      spaces: Space[];
      invitations: AccountInvitation[];
    }
  | {
      status: "ready";
      identity: Identity;
      spaces: Space[];
      space: string;
      invitations: AccountInvitation[];
    };

/**
 * Pending invitations for the signed-in email. Best-effort — an error (e.g. an
 * unverified email) yields an empty list rather than blocking the gate.
 */
async function fetchInvitations(): Promise<AccountInvitation[]> {
  try {
    const { invitations } = await userClient.invite.pending();
    return invitations.map((i) => ({
      invitationId: i.invitationId,
      spaceName: i.spaceName,
      spaceSlug: i.spaceSlug,
      admin: i.admin,
      shareAccess: i.shareAccess,
      invitedByName: i.invitedByName,
    }));
  } catch {
    return [];
  }
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const [whoami, spacesRes, invitations] = await Promise.all([
        userClient.whoami(),
        userClient.space.list(),
        fetchInvitations(),
      ]);
      // whoami's email is nullable; fall back to the display name so the
      // header always has something to show.
      const identity: Identity = {
        email: whoami.email ?? whoami.name,
        name: whoami.name,
      };
      let spaces: Space[] = spacesRes.spaces.map((s) => ({
        slug: s.slug,
        name: s.name,
        admin: s.admin,
      }));
      if (spaces.length === 0) {
        // Invited but space-less → let the user accept before we manufacture a
        // personal space. No invites → provision a default one now (explicit,
        // not done lazily server-side anymore).
        if (invitations.length > 0) {
          setState({ status: "onboarding", identity, invitations });
          return;
        }
        const { created, space } = await userClient.space.ensureDefault();
        if (created && space) {
          spaces = [{ slug: space.slug, name: space.name, admin: space.admin }];
        } else {
          // ensureDefault was a no-op — e.g. a concurrent tab/device already
          // created (or the user joined) a space. Re-fetch before concluding
          // the user has nowhere to go.
          spaces = (await userClient.space.list()).spaces.map((s) => ({
            slug: s.slug,
            name: s.name,
            admin: s.admin,
          }));
          if (spaces.length === 0) {
            setState({ status: "onboarding", identity, invitations });
            return;
          }
        }
      }
      const saved = localStorage.getItem(SPACE_STORAGE_KEY);
      const chosen =
        spaces.find((s) => s.slug === saved)?.slug ??
        (spaces.length === 1 ? spaces[0]?.slug : undefined);
      if (chosen) {
        memoryClient.setSpace(chosen);
        setState({
          status: "ready",
          identity,
          spaces,
          space: chosen,
          invitations,
        });
      } else {
        setState({ status: "needs-space", identity, spaces, invitations });
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

  // Accept / decline an invitation, then refresh the whole gate (a joined space
  // now shows up; the invitation drops off the pending list).
  const acceptInvite = useCallback(
    async (invitationId: string) => {
      await userClient.invite.accept({ invitationId });
      await load();
    },
    [load],
  );
  const declineInvite = useCallback(
    async (invitationId: string) => {
      await userClient.invite.decline({ invitationId });
      await load();
    },
    [load],
  );
  const createDefaultSpace = useCallback(async () => {
    await userClient.space.ensureDefault();
    await load();
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

  if (state.status === "onboarding") {
    return (
      <OnboardingScreen
        identity={state.identity}
        invitations={state.invitations}
        onAccept={acceptInvite}
        onDecline={declineInvite}
        onCreateSpace={createDefaultSpace}
        onLogout={logout}
      />
    );
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
        invitations: state.invitations,
        onAcceptInvite: acceptInvite,
        onDeclineInvite: declineInvite,
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

/**
 * Zero-space onboarding. Shown when the user belongs to no space yet: list any
 * invitations to accept, or create a personal space. Accepting / creating
 * refreshes the gate (which then lands in the app).
 */
function OnboardingScreen({
  identity,
  invitations,
  onAccept,
  onDecline,
  onCreateSpace,
  onLogout,
}: {
  identity: Identity;
  invitations: AccountInvitation[];
  onAccept: (invitationId: string) => Promise<void>;
  onDecline: (invitationId: string) => Promise<void>;
  onCreateSpace: () => Promise<void>;
  onLogout: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const createSpace = async () => {
    setBusy(true);
    try {
      await onCreateSpace();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h1 className="text-lg font-semibold text-ink">Welcome</h1>
      <p className="mt-1 text-[13px] text-ink/55">
        Signed in as {identity.email}
      </p>
      {invitations.length > 0 ? (
        <>
          <p className="mt-6 text-[13px] text-ink/70">
            You've been invited to{" "}
            {invitations.length === 1 ? "a space" : "these spaces"}:
          </p>
          <div className="mt-3">
            <InvitationList
              invitations={invitations}
              onAccept={onAccept}
              onDecline={onDecline}
            />
          </div>
          <p className="mt-4 text-[12px] text-ink/45">or</p>
        </>
      ) : (
        <p className="mt-6 text-[13px] text-ink/70">
          You don't belong to any space yet.
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={createSpace}
        className="mt-3 inline-flex h-9 items-center rounded-md bg-solar px-4 text-[13px] font-semibold text-ink transition-colors hover:bg-solar-hover disabled:opacity-50"
      >
        {busy ? "Creating…" : "Create a personal space"}
      </button>
      <button
        type="button"
        onClick={onLogout}
        className="mt-4 block text-[12px] text-ink/40 hover:text-ink/70"
      >
        Sign out
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
