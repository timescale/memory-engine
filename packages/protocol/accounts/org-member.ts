/**
 * Org member method schemas — params and results for org.member.* RPC methods.
 */
import { z } from "zod";
import { orgRoleSchema, uuidv7Schema } from "../fields.ts";

// =============================================================================
// Params Schemas
// =============================================================================

/**
 * org.member.list params.
 */
export const orgMemberListParams = z.object({
  orgId: uuidv7Schema,
});

export type OrgMemberListParams = z.infer<typeof orgMemberListParams>;

/**
 * org.member.add params.
 */
export const orgMemberAddParams = z.object({
  orgId: uuidv7Schema,
  identityId: uuidv7Schema,
  role: orgRoleSchema,
});

export type OrgMemberAddParams = z.infer<typeof orgMemberAddParams>;

/**
 * org.member.remove params.
 */
export const orgMemberRemoveParams = z.object({
  orgId: uuidv7Schema,
  identityId: uuidv7Schema,
});

export type OrgMemberRemoveParams = z.infer<typeof orgMemberRemoveParams>;

/**
 * org.member.updateRole params.
 */
export const orgMemberUpdateRoleParams = z.object({
  orgId: uuidv7Schema,
  identityId: uuidv7Schema,
  role: orgRoleSchema,
});

export type OrgMemberUpdateRoleParams = z.infer<
  typeof orgMemberUpdateRoleParams
>;

// =============================================================================
// Result Schemas
// =============================================================================

/**
 * Single org member response — returned by add, used in list.
 */
export const orgMemberResponse = z.object({
  orgId: z.string(),
  identityId: z.string(),
  role: z.string(),
  createdAt: z.string(),
});

export type OrgMemberResponse = z.infer<typeof orgMemberResponse>;

/**
 * org.member.list result.
 */
export const orgMemberListResult = z.object({
  members: z.array(orgMemberResponse),
});

export type OrgMemberListResult = z.infer<typeof orgMemberListResult>;

/**
 * org.member.remove result.
 */
export const orgMemberRemoveResult = z.object({
  removed: z.boolean(),
});

export type OrgMemberRemoveResult = z.infer<typeof orgMemberRemoveResult>;

/**
 * org.member.updateRole result.
 */
export const orgMemberUpdateRoleResult = z.object({
  updated: z.boolean(),
});

export type OrgMemberUpdateRoleResult = z.infer<
  typeof orgMemberUpdateRoleResult
>;
