/**
 * Invitation UI — the invitee's view of invitations addressed to their email.
 *
 * `InvitationList` is the shared presentational list (Accept / Decline per row),
 * reused by the header's `InvitationsButton` dropdown and by the zero-space
 * onboarding screen in `AuthGate`. Acceptance joins the space; declining removes
 * the invitation. Both call back into the handlers the `AuthGate` provides
 * (which refresh the session afterward).
 */
import { useState } from "react";
import { Dialog } from "../dialogs/Dialog.tsx";
import { type AccountInvitation, useAccount } from "./account-context.ts";

export function InvitationList({
  invitations,
  onAccept,
  onDecline,
}: {
  invitations: AccountInvitation[];
  onAccept: (invitationId: string) => Promise<void>;
  onDecline: (invitationId: string) => Promise<void>;
}) {
  // Track the row currently mid-action to disable its buttons.
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (id: string, fn: (id: string) => Promise<void>) => {
    setBusy(id);
    try {
      await fn(id);
    } finally {
      setBusy(null);
    }
  };

  if (invitations.length === 0) {
    return <p className="text-[13px] text-ink/55">No pending invitations.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {invitations.map((inv) => (
        <li
          key={inv.invitationId}
          className="flex items-center justify-between gap-3 rounded-md border border-ink/[0.14] px-3 py-2"
        >
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-ink">
              {inv.spaceName}
            </div>
            <div className="truncate text-[11px] text-ink/50">
              {inv.admin ? "admin · " : ""}
              {inv.groupNames.join(", ") || "no group"}
              {inv.invitedByName ? ` · from ${inv.invitedByName}` : ""}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run(inv.invitationId, onAccept)}
              className="rounded-md bg-solar px-3 py-1 text-[12px] font-semibold text-solar-ink transition-colors hover:bg-solar-hover disabled:opacity-50"
            >
              {busy === inv.invitationId ? "…" : "Accept"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run(inv.invitationId, onDecline)}
              className="rounded-md border border-ink/[0.18] px-3 py-1 text-[12px] font-medium text-ink/70 transition-colors hover:border-ink disabled:opacity-50"
            >
              Decline
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Header control: an "Invitations (N)" button that opens a dialog listing the
 * pending invitations. Renders nothing when there are none (or in local mode,
 * which provides no invitation handlers).
 */
export function InvitationsButton() {
  const account = useAccount();
  const [open, setOpen] = useState(false);

  const invitations = account?.invitations ?? [];
  const onAccept = account?.onAcceptInvite;
  const onDecline = account?.onDeclineInvite;
  if (invitations.length === 0 || !onAccept || !onDecline) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-solar px-2.5 py-[5px] font-semibold text-solar-ink transition-colors hover:bg-solar-hover"
      >
        Invitations ({invitations.length})
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Pending invitations"
      >
        <InvitationList
          invitations={invitations}
          onAccept={async (id) => {
            await onAccept(id);
          }}
          onDecline={async (id) => {
            await onDecline(id);
          }}
        />
      </Dialog>
    </>
  );
}
