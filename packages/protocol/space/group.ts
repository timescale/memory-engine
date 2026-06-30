/**
 * Group method schemas (group.*).
 *
 * Groups are space-scoped principals used to bundle members for tree-access
 * grants. A group is itself rostered into its space (principal_space), which is
 * what makes it resolvable/grantable by name — but group membership alone does
 * NOT confer space membership on a user/agent: a group's grants (and its admin
 * flag, if it's an admin group) apply to a member only once they have also joined
 * the space directly.
 */
import { z } from "zod";
import { principalHandleNameSchema, uuidv7Schema } from "../fields.ts";
import { principalKindSchema } from "./principal.ts";

export const groupResponse = z.object({
  id: z.string(),
  name: z.string(),
  // Whether this is an admin group (its own principal_space.admin) — its
  // space-admin authority flows to its direct-member users. Distinct from a group
  // member's own admin flag (groupMemberResponse.admin).
  isSpaceAdmin: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});
export type GroupResponse = z.infer<typeof groupResponse>;

export const groupMemberResponse = z.object({
  memberId: z.string(),
  kind: principalKindSchema,
  name: z.string(),
  admin: z.boolean(),
  createdAt: z.string(),
});
export type GroupMemberResponse = z.infer<typeof groupMemberResponse>;

export const groupMembershipResponse = z.object({
  groupId: z.string(),
  name: z.string(),
  admin: z.boolean(),
  createdAt: z.string(),
});
export type GroupMembershipResponse = z.infer<typeof groupMembershipResponse>;

// group.create
export const groupCreateParams = z.object({
  name: principalHandleNameSchema,
  // Create as an admin group (its members who are also space members gain
  // space-admin). Defaults false. Admin-gated on the server.
  isSpaceAdmin: z.boolean().optional(),
});
export type GroupCreateParams = z.infer<typeof groupCreateParams>;

export const groupCreateResult = z.object({ id: z.string() });
export type GroupCreateResult = z.infer<typeof groupCreateResult>;

// group.setIsSpaceAdmin — toggle a group's admin-group status
// (principal_space.admin). Distinct from a group member's admin flag. Demotion
// is guarded by the space's last-admin safeguard.
export const groupSetIsSpaceAdminParams = z.object({
  id: uuidv7Schema,
  isSpaceAdmin: z.boolean(),
});
export type GroupSetIsSpaceAdminParams = z.infer<
  typeof groupSetIsSpaceAdminParams
>;

export const groupSetIsSpaceAdminResult = z.object({
  isSpaceAdmin: z.boolean(),
  updated: z.boolean(),
});
export type GroupSetIsSpaceAdminResult = z.infer<
  typeof groupSetIsSpaceAdminResult
>;

// group.list
export const groupListParams = z.object({});
export type GroupListParams = z.infer<typeof groupListParams>;

export const groupListResult = z.object({ groups: z.array(groupResponse) });
export type GroupListResult = z.infer<typeof groupListResult>;

// group.rename
export const groupRenameParams = z.object({
  id: uuidv7Schema,
  name: principalHandleNameSchema,
});
export type GroupRenameParams = z.infer<typeof groupRenameParams>;

export const groupRenameResult = z.object({ renamed: z.boolean() });
export type GroupRenameResult = z.infer<typeof groupRenameResult>;

// group.delete
export const groupDeleteParams = z.object({ id: uuidv7Schema });
export type GroupDeleteParams = z.infer<typeof groupDeleteParams>;

export const groupDeleteResult = z.object({ deleted: z.boolean() });
export type GroupDeleteResult = z.infer<typeof groupDeleteResult>;

// group.addMember
export const groupAddMemberParams = z.object({
  groupId: uuidv7Schema,
  memberId: uuidv7Schema,
  admin: z.boolean().optional(),
});
export type GroupAddMemberParams = z.infer<typeof groupAddMemberParams>;

export const groupAddMemberResult = z.object({ added: z.boolean() });
export type GroupAddMemberResult = z.infer<typeof groupAddMemberResult>;

// group.removeMember
export const groupRemoveMemberParams = z.object({
  groupId: uuidv7Schema,
  memberId: uuidv7Schema,
});
export type GroupRemoveMemberParams = z.infer<typeof groupRemoveMemberParams>;

export const groupRemoveMemberResult = z.object({ removed: z.boolean() });
export type GroupRemoveMemberResult = z.infer<typeof groupRemoveMemberResult>;

// group.listMembers
export const groupListMembersParams = z.object({ groupId: uuidv7Schema });
export type GroupListMembersParams = z.infer<typeof groupListMembersParams>;

export const groupListMembersResult = z.object({
  members: z.array(groupMemberResponse),
});
export type GroupListMembersResult = z.infer<typeof groupListMembersResult>;

// group.listForMember
export const groupListForMemberParams = z.object({ memberId: uuidv7Schema });
export type GroupListForMemberParams = z.infer<typeof groupListForMemberParams>;

export const groupListForMemberResult = z.object({
  groups: z.array(groupMembershipResponse),
});
export type GroupListForMemberResult = z.infer<typeof groupListForMemberResult>;
