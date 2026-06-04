/**
 * Group method schemas (group.*).
 *
 * Groups are space-scoped principals used to bundle members for tree-access
 * grants. Group membership confers space access (a group member is a space
 * member, flagged direct=false in principal.list).
 */
import { z } from "zod";
import { nameSchema, uuidv7Schema } from "../fields.ts";
import { principalKindSchema } from "./principal.ts";

export const groupResponse = z.object({
  id: z.string(),
  name: z.string(),
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
export const groupCreateParams = z.object({ name: nameSchema });
export type GroupCreateParams = z.infer<typeof groupCreateParams>;

export const groupCreateResult = z.object({ id: z.string() });
export type GroupCreateResult = z.infer<typeof groupCreateResult>;

// group.list
export const groupListParams = z.object({});
export type GroupListParams = z.infer<typeof groupListParams>;

export const groupListResult = z.object({ groups: z.array(groupResponse) });
export type GroupListResult = z.infer<typeof groupListResult>;

// group.rename
export const groupRenameParams = z.object({
  id: uuidv7Schema,
  name: nameSchema,
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
