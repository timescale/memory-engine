/**
 * Space invitation method schemas (invite.*).
 *
 * Invitations are keyed by invitee email so an invite can be issued before the
 * user registers. Inviting an *already-registered* user adds them to the space
 * immediately (instant access on their existing session); inviting a not-yet-
 * registered email records a pending invitation, redeemed at their first
 * verified login. Each invite carries whether to make the user a space admin and
 * an optional share level (read/write/owner at the shared root; null = none).
 */
import { z } from "zod";
import { emailSchema } from "../fields.ts";
import { accessLevelSchema } from "./grant.ts";

/** A pending invitation to the space. */
export const spaceInvitationResponse = z.object({
  id: z.string(),
  email: z.string(),
  admin: z.boolean(),
  /** Share-root access granted on redemption; null = no share grant. */
  shareAccess: accessLevelSchema.nullable(),
  invitedBy: z.string().nullable(),
  invitedByName: z.string().nullable(),
  createdAt: z.string(),
});
export type SpaceInvitationResponse = z.infer<typeof spaceInvitationResponse>;

// invite.create — invite by email; adds an existing user now, else records a
// pending invite. `admin` defaults false; `shareAccess` null/omitted = no share.
export const inviteCreateParams = z.object({
  email: emailSchema,
  admin: z.boolean().optional(),
  shareAccess: accessLevelSchema.nullable().optional(),
});
export type InviteCreateParams = z.infer<typeof inviteCreateParams>;

export const inviteCreateResult = z.object({
  /** True when the invitee was an existing user and was added to the space now. */
  applied: z.boolean(),
  /** The pending invitation id (null when applied immediately). */
  invitationId: z.string().nullable(),
  /** The principal added now (null when deferred to a pending invitation). */
  principalId: z.string().nullable(),
});
export type InviteCreateResult = z.infer<typeof inviteCreateResult>;

// invite.list — pending invitations for the space
export const inviteListParams = z.object({});
export type InviteListParams = z.infer<typeof inviteListParams>;

export const inviteListResult = z.object({
  invitations: z.array(spaceInvitationResponse),
});
export type InviteListResult = z.infer<typeof inviteListResult>;

// invite.revoke — delete a pending invitation by email
export const inviteRevokeParams = z.object({ email: emailSchema });
export type InviteRevokeParams = z.infer<typeof inviteRevokeParams>;

export const inviteRevokeResult = z.object({ revoked: z.boolean() });
export type InviteRevokeResult = z.infer<typeof inviteRevokeResult>;
