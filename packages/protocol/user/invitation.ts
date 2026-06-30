/**
 * Invitee-side invitation method schemas (invite.*) for the **user RPC**.
 *
 * An invitee is not yet a space member, so `build_tree_access` is empty and they
 * cannot reach the space endpoint. These account-scoped methods (gated by the
 * caller's verified email) let them see and act on invitations addressed to them:
 * list the pending ones, accept (join the space), or decline. Distinct from the
 * admin-side `invite.*` on the space RPC (create/list/revoke for a space).
 */
import { z } from "zod";
import { accessLevelSchema } from "../space/grant.ts";

/** A pending invitation addressed to the caller's email. */
export const pendingInvitationResponse = z.object({
  invitationId: z.string(),
  spaceId: z.string(),
  spaceSlug: z.string(),
  spaceName: z.string(),
  admin: z.boolean(),
  /** Share-root access granted on acceptance; null = no share grant. */
  shareAccess: accessLevelSchema.nullable(),
  invitedByName: z.string().nullable(),
  createdAt: z.string(),
});
export type PendingInvitationResponse = z.infer<
  typeof pendingInvitationResponse
>;

// invite.pending — invitations addressed to the caller's verified email
export const invitePendingParams = z.object({});
export type InvitePendingParams = z.infer<typeof invitePendingParams>;

export const invitePendingResult = z.object({
  invitations: z.array(pendingInvitationResponse),
});
export type InvitePendingResult = z.infer<typeof invitePendingResult>;

// invite.accept — accept one pending invitation by id (joins the space)
export const inviteAcceptParams = z.object({ invitationId: z.string() });
export type InviteAcceptParams = z.infer<typeof inviteAcceptParams>;

export const inviteAcceptResult = z.object({
  spaceSlug: z.string(),
  spaceName: z.string(),
});
export type InviteAcceptResult = z.infer<typeof inviteAcceptResult>;

// invite.decline — decline (delete) one pending invitation by id
export const inviteDeclineParams = z.object({ invitationId: z.string() });
export type InviteDeclineParams = z.infer<typeof inviteDeclineParams>;

export const inviteDeclineResult = z.object({ declined: z.boolean() });
export type InviteDeclineResult = z.infer<typeof inviteDeclineResult>;
