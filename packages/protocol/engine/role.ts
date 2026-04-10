/**
 * Role method schemas — params and results for role.* RPC methods.
 */
import { z } from "zod";
import { uuidv7Schema } from "../fields.ts";

// =============================================================================
// Params Schemas
// =============================================================================

/**
 * role.create params.
 * Creates a user with canLogin=false (a role for grouping grants).
 */
export const roleCreateParams = z.object({
  name: z.string().min(1, "name is required"),
  identityId: uuidv7Schema.optional().nullable(),
});

export type RoleCreateParams = z.infer<typeof roleCreateParams>;

/**
 * role.addMember params.
 */
export const roleAddMemberParams = z.object({
  roleId: uuidv7Schema,
  memberId: uuidv7Schema,
  withAdminOption: z.boolean().optional(),
});

export type RoleAddMemberParams = z.infer<typeof roleAddMemberParams>;

/**
 * role.removeMember params.
 */
export const roleRemoveMemberParams = z.object({
  roleId: uuidv7Schema,
  memberId: uuidv7Schema,
});

export type RoleRemoveMemberParams = z.infer<typeof roleRemoveMemberParams>;

/**
 * role.listMembers params.
 */
export const roleListMembersParams = z.object({
  roleId: uuidv7Schema,
});

export type RoleListMembersParams = z.infer<typeof roleListMembersParams>;

/**
 * role.listForUser params.
 */
export const roleListForUserParams = z.object({
  userId: uuidv7Schema,
});

export type RoleListForUserParams = z.infer<typeof roleListForUserParams>;

// =============================================================================
// Result Schemas
// =============================================================================

/**
 * Single role response — returned by create.
 */
export const roleResponse = z.object({
  id: z.string(),
  name: z.string(),
  identityId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});

export type RoleResponse = z.infer<typeof roleResponse>;

/**
 * Role member response — used in listMembers result.
 */
export const roleMemberResponse = z.object({
  roleId: z.string(),
  memberId: z.string(),
  withAdminOption: z.boolean(),
  createdAt: z.string(),
});

export type RoleMemberResponse = z.infer<typeof roleMemberResponse>;

/**
 * Role info response — used in listForUser result.
 */
export const roleInfoResponse = z.object({
  id: z.string(),
  name: z.string(),
  withAdminOption: z.boolean(),
});

export type RoleInfoResponse = z.infer<typeof roleInfoResponse>;

/**
 * role.addMember result.
 */
export const roleAddMemberResult = z.object({
  added: z.boolean(),
});

export type RoleAddMemberResult = z.infer<typeof roleAddMemberResult>;

/**
 * role.removeMember result.
 */
export const roleRemoveMemberResult = z.object({
  removed: z.boolean(),
});

export type RoleRemoveMemberResult = z.infer<typeof roleRemoveMemberResult>;

/**
 * role.listMembers result.
 */
export const roleListMembersResult = z.object({
  members: z.array(roleMemberResponse),
});

export type RoleListMembersResult = z.infer<typeof roleListMembersResult>;

/**
 * role.listForUser result.
 */
export const roleListForUserResult = z.object({
  roles: z.array(roleInfoResponse),
});

export type RoleListForUserResult = z.infer<typeof roleListForUserResult>;
