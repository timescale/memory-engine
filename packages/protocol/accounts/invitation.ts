/**
 * Invitation method schemas — params and results for invitation.* RPC methods.
 */
import { z } from "zod";
import { emailSchema, orgRoleSchema, uuidv7Schema } from "../fields.ts";

// =============================================================================
// Params Schemas
// =============================================================================

/**
 * invitation.create params.
 */
export const invitationCreateParams = z.object({
  orgId: uuidv7Schema,
  email: emailSchema,
  role: orgRoleSchema,
  expiresInDays: z.number().int().min(1).max(30).optional(),
});

export type InvitationCreateParams = z.infer<typeof invitationCreateParams>;

/**
 * invitation.list params.
 */
export const invitationListParams = z.object({
  orgId: uuidv7Schema,
});

export type InvitationListParams = z.infer<typeof invitationListParams>;

/**
 * invitation.revoke params.
 */
export const invitationRevokeParams = z.object({
  id: uuidv7Schema,
});

export type InvitationRevokeParams = z.infer<typeof invitationRevokeParams>;

/**
 * invitation.accept params.
 * Token is the raw invitation token from the email link.
 */
export const invitationAcceptParams = z.object({
  token: z.string().min(1, "token is required"),
});

export type InvitationAcceptParams = z.infer<typeof invitationAcceptParams>;

// =============================================================================
// Result Schemas
// =============================================================================

/**
 * Invitation response — returned by list.
 */
export const invitationResponse = z.object({
  id: z.string(),
  orgId: z.string(),
  email: z.string(),
  role: z.string(),
  invitedBy: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  createdAt: z.string(),
});

export type InvitationResponse = z.infer<typeof invitationResponse>;

/**
 * invitation.create result — includes the raw token (only returned on creation).
 */
export const invitationCreateResult = invitationResponse.extend({
  token: z.string(),
});

export type InvitationCreateResult = z.infer<typeof invitationCreateResult>;

/**
 * invitation.list result.
 */
export const invitationListResult = z.object({
  invitations: z.array(invitationResponse),
});

export type InvitationListResult = z.infer<typeof invitationListResult>;

/**
 * invitation.revoke result.
 */
export const invitationRevokeResult = z.object({
  revoked: z.boolean(),
});

export type InvitationRevokeResult = z.infer<typeof invitationRevokeResult>;

/**
 * invitation.accept result.
 */
export const invitationAcceptResult = z.object({
  accepted: z.boolean(),
  orgId: z.string(),
});

export type InvitationAcceptResult = z.infer<typeof invitationAcceptResult>;
