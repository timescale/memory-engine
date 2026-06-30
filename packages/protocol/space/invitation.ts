/**
 * Space invitation method schemas (invite.*) — the admin side, on the space RPC.
 *
 * Invitations are keyed by invitee email so an invite can be issued before the
 * user registers. Every invite is recorded as **pending**; the invitee joins by
 * explicitly accepting it (see the invitee-side `invite.*` on the user RPC),
 * never by auto-enrollment. Each invite carries whether to make the user a space
 * admin and an optional share level (read/write/owner at the shared root; null =
 * none).
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

// invite.create — invite by email; always records a PENDING invitation (no
// auto-enroll, even for an existing user). `admin` defaults false; `shareAccess`
// null/omitted = no share.
export const inviteCreateParams = z.object({
  email: emailSchema,
  admin: z.boolean().optional(),
  shareAccess: accessLevelSchema.nullable().optional(),
});
export type InviteCreateParams = z.infer<typeof inviteCreateParams>;

export const inviteCreateResult = z.object({
  /** The pending invitation id. */
  invitationId: z.string(),
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
