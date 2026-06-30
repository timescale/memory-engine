/**
 * Space invitation method schemas (invite.*) — the admin side, on the space RPC.
 *
 * One unified surface: an invite with an `email` is email-constrained (only that
 * verified email may redeem, single-use); an invite with no email is an open
 * shareable link (anyone logged in may redeem, multi-use, optional expiry /
 * max-uses). Every invite is **pending** until redeemed — the invitee joins by
 * explicitly accepting (email-keyed, on the user RPC) or by redeeming the token
 * link; no path auto-enrolls. `invite.create` mints and returns the magic-link
 * token once.
 */
import { z } from "zod";
import { emailSchema } from "../fields.ts";
import { accessLevelSchema } from "./grant.ts";

/** An active invitation to the space (email-constrained or an open link). */
export const spaceInvitationResponse = z.object({
  id: z.string(),
  /** Invitee email — null for an open shareable link. */
  email: z.string().nullable(),
  /** "email" = email-constrained (single-use); "link" = open shareable link. */
  kind: z.enum(["email", "link"]),
  admin: z.boolean(),
  /** Share-root access granted on redemption; null = no share grant. */
  shareAccess: accessLevelSchema.nullable(),
  invitedBy: z.string().nullable(),
  invitedByName: z.string().nullable(),
  /** When an open link expires (ISO); null = never. */
  expiresAt: z.string().nullable(),
  /** Max redemptions for an open link; null = unlimited. */
  maxUses: z.number().int().nullable(),
  /** Redemptions so far. */
  uses: z.number().int(),
  /** Whether it can still be redeemed (false = expired / exhausted). */
  valid: z.boolean(),
  createdAt: z.string(),
});
export type SpaceInvitationResponse = z.infer<typeof spaceInvitationResponse>;

// invite.create — create an invitation and mint its magic-link token. `email`
// set → email-constrained (single-use); `email` null/omitted → an open shareable
// link (bounded by `expiresAt` / `maxUses`). Always pending — no auto-enroll.
export const inviteCreateParams = z.object({
  email: emailSchema.nullable().optional(),
  admin: z.boolean().optional(),
  shareAccess: accessLevelSchema.nullable().optional(),
  /** Open-link expiry (ISO timestamp); null/omitted = never. */
  expiresAt: z.string().datetime().nullable().optional(),
  /** Open-link max redemptions; null/omitted = unlimited. */
  maxUses: z.number().int().positive().nullable().optional(),
});
export type InviteCreateParams = z.infer<typeof inviteCreateParams>;

export const inviteCreateResult = z.object({
  /** The invitation id. */
  invitationId: z.string(),
  /** The full magic-link token (`inv.<lookupId>.<secret>`), shown once. */
  token: z.string(),
});
export type InviteCreateResult = z.infer<typeof inviteCreateResult>;

// invite.list — active invitations for the space (email + link)
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

// invite.revokeById — revoke any invitation (open link or email) by id
export const inviteRevokeByIdParams = z.object({ invitationId: z.string() });
export type InviteRevokeByIdParams = z.infer<typeof inviteRevokeByIdParams>;

export const inviteRevokeByIdResult = z.object({ revoked: z.boolean() });
export type InviteRevokeByIdResult = z.infer<typeof inviteRevokeByIdResult>;
