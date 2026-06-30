/**
 * Admin "Invite link" header control (hosted mode).
 *
 * Lets a space admin mint an open shareable magic link, copy it, and revoke
 * existing links. Renders nothing unless the signed-in user is an admin of the
 * active space. Uses the space (memory) RPC, scoped to the active X-Me-Space.
 */
import { isRpcError } from "@memory.build/client";
import { useCallback, useEffect, useState } from "react";
import { memoryClient } from "../../api/client.ts";
import { Dialog } from "../dialogs/Dialog.tsx";
import { useAccount } from "./account-context.ts";

/** The invitation rows returned by the memory client's `invite.list`. */
type Invitation = Awaited<
  ReturnType<typeof memoryClient.invite.list>
>["invitations"][number];

type Share = "none" | "read" | "write" | "owner";
const SHARE_LEVEL: Record<Share, 1 | 2 | 3 | null> = {
  none: null,
  read: 1,
  write: 2,
  owner: 3,
};

function inviteUrl(token: string): string {
  return `${window.location.origin}/invite/${token}`;
}

export function InviteLinkButton() {
  const account = useAccount();
  const [open, setOpen] = useState(false);

  const isAdmin =
    account?.spaces.find((s) => s.slug === account.space)?.admin ?? false;
  if (!account || !isAdmin) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-ink/50 hover:text-ink hover:underline"
      >
        Invite link
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Invite links">
        <InviteLinkPanel />
      </Dialog>
    </>
  );
}

function InviteLinkPanel() {
  const [links, setLinks] = useState<Invitation[]>([]);
  const [share, setShare] = useState<Share>("read");
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { invitations } = await memoryClient.invite.list();
      setLinks(invitations.filter((i) => i.kind === "link"));
    } catch (err) {
      setError(isRpcError(err) ? err.message : "Couldn't load invite links.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { token } = await memoryClient.invite.create({
        admin,
        shareAccess: SHARE_LEVEL[share],
      });
      setCreated(inviteUrl(token));
      await refresh();
    } catch (err) {
      setError(
        isRpcError(err) ? err.message : "Couldn't create the invite link.",
      );
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    try {
      await memoryClient.invite.revokeById({ invitationId: id });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex items-center gap-2">
          <select
            value={share}
            onChange={(e) => setShare(e.target.value as Share)}
            className="rounded-md border border-ink/[0.18] px-2 py-1 text-[13px]"
            aria-label="Share access"
          >
            <option value="none">no share access</option>
            <option value="read">read</option>
            <option value="write">write</option>
            <option value="owner">owner</option>
          </select>
          <label className="flex items-center gap-1 text-[13px] text-ink/70">
            <input
              type="checkbox"
              checked={admin}
              onChange={(e) => setAdmin(e.target.checked)}
            />
            admin
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={create}
            className="ml-auto rounded-md bg-solar px-3 py-1 text-[12px] font-semibold text-ink hover:bg-solar-hover disabled:opacity-50"
          >
            Create link
          </button>
        </div>
        {created && (
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded bg-ink/[0.06] px-2 py-1 font-mono text-[12px] text-ink">
              {created}
            </code>
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(created)}
              className="shrink-0 rounded-md border border-ink/[0.18] px-2 py-1 text-[12px] text-ink/70 hover:border-ink"
            >
              Copy
            </button>
          </div>
        )}
        {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}
      </div>

      <div>
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink/45">
          Active links
        </h3>
        {links.length === 0 ? (
          <p className="mt-1 text-[13px] text-ink/55">No active links.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {links.map((l) => (
              <li
                key={l.id}
                className="flex items-center justify-between gap-3 text-[12px]"
              >
                <span className="truncate text-ink/70">
                  {l.admin ? "admin · " : ""}
                  {l.shareAccess === null
                    ? "no share"
                    : l.shareAccess === 1
                      ? "read"
                      : l.shareAccess === 2
                        ? "write"
                        : "owner"}
                  {" · "}
                  {l.uses}
                  {l.maxUses != null ? `/${l.maxUses}` : ""} used
                  {!l.valid && (
                    <span className="ml-1 rounded bg-ink/[0.08] px-1 text-[11px] text-ink/50">
                      expired/used
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  {l.token && (
                    <button
                      type="button"
                      onClick={() =>
                        l.token &&
                        void navigator.clipboard?.writeText(inviteUrl(l.token))
                      }
                      className="text-ink/50 hover:text-ink hover:underline"
                    >
                      Copy link
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => revoke(l.id)}
                    className="text-ink/50 hover:text-ink hover:underline disabled:opacity-50"
                  >
                    Revoke
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
