/**
 * Zod schemas for Accounts RPC methods.
 *
 * These schemas define the expected params for each method.
 * Zod 4 compatible.
 */
import { z } from "zod";

// =============================================================================
// Common Schemas
// =============================================================================

/**
 * UUID v7 schema using Zod 4's native uuidv7 support.
 */
export const uuidv7Schema = z.uuidv7();

/**
 * Org role schema.
 */
export const orgRoleSchema = z.enum(["owner", "admin", "member"]);

/**
 * Engine status schema.
 */
export const engineStatusSchema = z.enum(["active", "suspended", "deleted"]);

/**
 * Slug schema (lowercase alphanumeric with hyphens, 3-50 chars).
 */
export const slugSchema = z
  .string()
  .min(3, "slug must be at least 3 characters")
  .max(50, "slug must be at most 50 characters")
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    "slug must be lowercase alphanumeric with hyphens",
  );

/**
 * Email schema using Zod 4's native support.
 */
export const emailSchema = z.email();

/**
 * Name schema (1-100 chars).
 */
export const nameSchema = z
  .string()
  .min(1, "name is required")
  .max(100, "name must be at most 100 characters");

// =============================================================================
// Identity (me) Method Schemas
// =============================================================================

/**
 * me.get params - no params needed, uses session identity.
 */
export const meGetSchema = z.object({});

export type MeGetParams = z.infer<typeof meGetSchema>;

// =============================================================================
// Session Method Schemas
// =============================================================================

/**
 * session.revoke params - revokes the current session (logout).
 * No params needed - uses the session from the auth token.
 */
export const sessionRevokeSchema = z.object({});

export type SessionRevokeParams = z.infer<typeof sessionRevokeSchema>;

// =============================================================================
// Org Method Schemas
// =============================================================================

/**
 * org.create params.
 */
export const orgCreateSchema = z.object({
  slug: slugSchema,
  name: nameSchema,
});

export type OrgCreateParams = z.infer<typeof orgCreateSchema>;

/**
 * org.list params - no params needed, lists orgs for session identity.
 */
export const orgListSchema = z.object({});

export type OrgListParams = z.infer<typeof orgListSchema>;

/**
 * org.get params.
 */
export const orgGetSchema = z.object({
  id: uuidv7Schema,
});

export type OrgGetParams = z.infer<typeof orgGetSchema>;

/**
 * org.update params.
 */
export const orgUpdateSchema = z.object({
  id: uuidv7Schema,
  name: nameSchema.optional(),
  slug: slugSchema.optional(),
});

export type OrgUpdateParams = z.infer<typeof orgUpdateSchema>;

/**
 * org.delete params.
 */
export const orgDeleteSchema = z.object({
  id: uuidv7Schema,
});

export type OrgDeleteParams = z.infer<typeof orgDeleteSchema>;

// =============================================================================
// Org Member Method Schemas
// =============================================================================

/**
 * org.member.list params.
 */
export const orgMemberListSchema = z.object({
  orgId: uuidv7Schema,
});

export type OrgMemberListParams = z.infer<typeof orgMemberListSchema>;

/**
 * org.member.add params.
 */
export const orgMemberAddSchema = z.object({
  orgId: uuidv7Schema,
  identityId: uuidv7Schema,
  role: orgRoleSchema,
});

export type OrgMemberAddParams = z.infer<typeof orgMemberAddSchema>;

/**
 * org.member.remove params.
 */
export const orgMemberRemoveSchema = z.object({
  orgId: uuidv7Schema,
  identityId: uuidv7Schema,
});

export type OrgMemberRemoveParams = z.infer<typeof orgMemberRemoveSchema>;

/**
 * org.member.updateRole params.
 */
export const orgMemberUpdateRoleSchema = z.object({
  orgId: uuidv7Schema,
  identityId: uuidv7Schema,
  role: orgRoleSchema,
});

export type OrgMemberUpdateRoleParams = z.infer<
  typeof orgMemberUpdateRoleSchema
>;

// =============================================================================
// Engine Method Schemas
// =============================================================================

/**
 * engine.create params.
 */
export const engineCreateSchema = z.object({
  orgId: uuidv7Schema,
  name: nameSchema,
});

export type EngineCreateParams = z.infer<typeof engineCreateSchema>;

/**
 * engine.list params.
 */
export const engineListSchema = z.object({
  orgId: uuidv7Schema,
});

export type EngineListParams = z.infer<typeof engineListSchema>;

/**
 * engine.get params.
 */
export const engineGetSchema = z.object({
  id: uuidv7Schema,
});

export type EngineGetParams = z.infer<typeof engineGetSchema>;

/**
 * engine.update params.
 */
export const engineUpdateSchema = z.object({
  id: uuidv7Schema,
  name: nameSchema.optional(),
  status: engineStatusSchema.optional(),
});

export type EngineUpdateParams = z.infer<typeof engineUpdateSchema>;

// =============================================================================
// Invitation Method Schemas
// =============================================================================

/**
 * invitation.create params.
 */
export const invitationCreateSchema = z.object({
  orgId: uuidv7Schema,
  email: emailSchema,
  role: orgRoleSchema,
  expiresInDays: z.number().int().min(1).max(30).optional(),
});

export type InvitationCreateParams = z.infer<typeof invitationCreateSchema>;

/**
 * invitation.list params.
 */
export const invitationListSchema = z.object({
  orgId: uuidv7Schema,
});

export type InvitationListParams = z.infer<typeof invitationListSchema>;

/**
 * invitation.revoke params.
 */
export const invitationRevokeSchema = z.object({
  id: uuidv7Schema,
});

export type InvitationRevokeParams = z.infer<typeof invitationRevokeSchema>;

/**
 * invitation.accept params.
 * Token is the raw invitation token from the email link.
 */
export const invitationAcceptSchema = z.object({
  token: z.string().min(1, "token is required"),
});

export type InvitationAcceptParams = z.infer<typeof invitationAcceptSchema>;
