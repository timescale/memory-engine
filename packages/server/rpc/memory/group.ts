/**
 * Group handlers (group.*). Groups are space-scoped principals that bundle
 * members for tree-access grants; group membership confers space access.
 */
import type {
  GroupAddMemberParams,
  GroupAddMemberResult,
  GroupCreateParams,
  GroupCreateResult,
  GroupDeleteParams,
  GroupDeleteResult,
  GroupListForMemberParams,
  GroupListForMemberResult,
  GroupListMembersParams,
  GroupListMembersResult,
  GroupListParams,
  GroupListResult,
  GroupRemoveMemberParams,
  GroupRemoveMemberResult,
  GroupRenameParams,
  GroupRenameResult,
} from "@memory.build/protocol/space";
import {
  groupAddMemberParams,
  groupCreateParams,
  groupDeleteParams,
  groupListForMemberParams,
  groupListMembersParams,
  groupListParams,
  groupRemoveMemberParams,
  groupRenameParams,
} from "@memory.build/protocol/space";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import {
  callerOwnsAgent,
  guardCore,
  requireGroupAdmin,
  requireSpaceAdmin,
  toGroupMemberResponse,
  toGroupMembershipResponse,
  toGroupResponse,
} from "./support";
import { assertSpaceRpcContext, type SpaceRpcContext } from "./types";

/** Guard that the group exists in this space. */
async function assertGroupInSpace(
  ctx: SpaceRpcContext,
  groupId: string,
): Promise<void> {
  const groups = await ctx.core.listSpaceGroups(ctx.space.id);
  if (!groups.some((g) => g.id === groupId)) {
    throw new AppError(
      "NOT_FOUND",
      `Group not found in this space: ${groupId}`,
    );
  }
}

async function groupCreate(
  params: GroupCreateParams,
  context: HandlerContext,
): Promise<GroupCreateResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  requireSpaceAdmin(ctx);
  const id = await guardCore(() =>
    ctx.core.createGroup(ctx.space.id, params.name),
  );
  return { id };
}

async function groupList(
  _params: GroupListParams,
  context: HandlerContext,
): Promise<GroupListResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  requireSpaceAdmin(ctx);
  const groups = await ctx.core.listSpaceGroups(ctx.space.id);
  return { groups: groups.map(toGroupResponse) };
}

async function groupRename(
  params: GroupRenameParams,
  context: HandlerContext,
): Promise<GroupRenameResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  requireSpaceAdmin(ctx);
  await assertGroupInSpace(ctx, params.id);
  const renamed = await guardCore(() =>
    ctx.core.renamePrincipal(params.id, params.name),
  );
  return { renamed };
}

async function groupDelete(
  params: GroupDeleteParams,
  context: HandlerContext,
): Promise<GroupDeleteResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  requireSpaceAdmin(ctx);
  await assertGroupInSpace(ctx, params.id);
  const deleted = await guardCore(() => ctx.core.deletePrincipal(params.id));
  return { deleted };
}

async function groupAddMember(
  params: GroupAddMemberParams,
  context: HandlerContext,
): Promise<GroupAddMemberResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  await requireGroupAdmin(ctx, params.groupId);
  await assertGroupInSpace(ctx, params.groupId);
  await guardCore(() =>
    ctx.core.addGroupMember(
      ctx.space.id,
      params.groupId,
      params.memberId,
      params.admin ?? false,
    ),
  );
  return { added: true };
}

async function groupRemoveMember(
  params: GroupRemoveMemberParams,
  context: HandlerContext,
): Promise<GroupRemoveMemberResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  await requireGroupAdmin(ctx, params.groupId);
  await assertGroupInSpace(ctx, params.groupId);
  const removed = await guardCore(() =>
    ctx.core.removeGroupMember(ctx.space.id, params.groupId, params.memberId),
  );
  return { removed };
}

async function groupListMembers(
  params: GroupListMembersParams,
  context: HandlerContext,
): Promise<GroupListMembersResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  await requireGroupAdmin(ctx, params.groupId);
  await assertGroupInSpace(ctx, params.groupId);
  const members = await ctx.core.listGroupMembers(ctx.space.id, params.groupId);
  return { members: members.map(toGroupMemberResponse) };
}

async function groupListForMember(
  params: GroupListForMemberParams,
  context: HandlerContext,
): Promise<GroupListForMemberResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  // You may see your OWN memberships, or those of an agent you own (so
  // `me agent group list` works); seeing anyone else's requires space-admin.
  if (
    params.memberId !== ctx.principalId &&
    !(await callerOwnsAgent(ctx, params.memberId))
  ) {
    requireSpaceAdmin(ctx);
  }
  const groups = await ctx.core.listGroupsForMember(
    ctx.space.id,
    params.memberId,
  );
  return { groups: groups.map(toGroupMembershipResponse) };
}

export const groupMethods = buildRegistry()
  .register("group.create", groupCreateParams, groupCreate)
  .register("group.list", groupListParams, groupList)
  .register("group.rename", groupRenameParams, groupRename)
  .register("group.delete", groupDeleteParams, groupDelete)
  .register("group.addMember", groupAddMemberParams, groupAddMember)
  .register("group.removeMember", groupRemoveMemberParams, groupRemoveMember)
  .register("group.listMembers", groupListMembersParams, groupListMembers)
  .register("group.listForMember", groupListForMemberParams, groupListForMember)
  .build();
