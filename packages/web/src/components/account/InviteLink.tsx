/**
 * Admin "Invite link" header control (hosted mode).
 *
 * Lets a space admin mint an open shareable magic link, copy it, and revoke
 * existing links. Renders nothing unless the signed-in user is an admin of the
 * active space. Uses the space (memory) RPC, scoped to the active X-Me-Space.
 */
import { DEFAULT_GROUP_NAME, isRpcError } from "@memory.build/client";
import { useCallback, useEffect, useState } from "react";
import { memoryClient } from "../../api/client.ts";
import { Dialog } from "../dialogs/Dialog.tsx";
import { useAccount } from "./account-context.ts";

/** The invitation rows returned by the memory client's `invite.list`. */
type Invitation = Awaited<
  ReturnType<typeof memoryClient.invite.list>
>["invitations"][number];

/** The group rows returned by the memory client's `group.list`. */
type Group = Awaited<
  ReturnType<typeof memoryClient.group.list>
>["groups"][number];

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
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [{ invitations }, groupsRes] = await Promise.all([
        memoryClient.invite.list(),
        memoryClient.group.list(),
      ]);
      setLinks(invitations.filter((i) => i.kind === "link"));
      setGroups(groupsRes.groups);
      // keep the selections that still exist; if none do, default to the "team"
      // group (fall back to the first) so we never submit a group that isn't an
      // option (which would create an invite that fails server-side).
      setGroupIds((cur) => {
        const live = cur.filter((id) =>
          groupsRes.groups.some((g) => g.id === id),
        );
        if (live.length > 0) return live;
        const fallback =
          groupsRes.groups.find(
            (g) => g.name.toLowerCase() === DEFAULT_GROUP_NAME,
          )?.id ?? groupsRes.groups[0]?.id;
        return fallback ? [fallback] : [];
      });
    } catch (err) {
      setError(isRpcError(err) ? err.message : "Couldn't load invite links.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleGroup = (id: string) =>
    setGroupIds((cur) =>
      cur.includes(id) ? cur.filter((g) => g !== id) : [...cur, id],
    );

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { token } = await memoryClient.invite.create({
        admin,
        groupIds,
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
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[13px] text-ink/70">Groups:</span>
            {groups.map((g) => (
              <label
                key={g.id}
                className="flex items-center gap-1 text-[13px] text-ink/70"
              >
                <input
                  type="checkbox"
                  checked={groupIds.includes(g.id)}
                  onChange={() => toggleGroup(g.id)}
                />
                {g.name}
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
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
              disabled={busy || groupIds.length === 0}
              onClick={create}
              className="ml-auto rounded-md bg-solar px-3 py-1 text-[12px] font-semibold text-solar-ink hover:bg-solar-hover disabled:opacity-50"
            >
              Create link
            </button>
          </div>
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
                  {l.groupNames.join(", ") || "no group"}
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
