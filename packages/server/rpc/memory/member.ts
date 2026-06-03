/**
 * Space membership handlers (member.*) — the space roster (principal_space).
 */
import type {
  MemberAddParams,
  MemberAddResult,
  MemberListParams,
  MemberListResult,
  MemberRemoveParams,
  MemberRemoveResult,
  MemberResolveByEmailParams,
  MemberResolveByEmailResult,
} from "@memory.build/protocol/space";
import {
  memberAddParams,
  memberListParams,
  memberRemoveParams,
  memberResolveByEmailParams,
} from "@memory.build/protocol/space";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import {
  callerOwnsAgentGlobal,
  guardCore,
  requireSpaceManager,
  toPrincipalResponse,
  toSpaceMemberResponse,
} from "./support";
import { assertSpaceRpcContext, type SpaceRpcContext } from "./types";

async function memberList(
  params: MemberListParams,
  context: HandlerContext,
): Promise<MemberListResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  requireSpaceManager(ctx);
  const members = await ctx.core.listSpaceMembers(
    ctx.space.id,
    params.kind ?? undefined,
  );
  return { members: members.map(toSpaceMemberResponse) };
}

async function memberAdd(
  params: MemberAddParams,
  context: HandlerContext,
): Promise<MemberAddResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  // Bringing your OWN agent into a space is self-service (it stays capped by
  // your access); adding anyone else requires space-owner authority. A member
  // can't grant themselves admin on their own agent membership.
  const ownAgent =
    params.admin !== true &&
    (await callerOwnsAgentGlobal(ctx, params.principalId));
  if (!ownAgent) {
    requireSpaceManager(ctx);
  }
  await guardCore(() =>
    ctx.core.addPrincipalToSpace(
      ctx.space.id,
      params.principalId,
      params.admin ?? false,
    ),
  );
  return { added: true };
}

async function memberRemove(
  params: MemberRemoveParams,
  context: HandlerContext,
): Promise<MemberRemoveResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  requireSpaceManager(ctx);
  const removed = await guardCore(() =>
    ctx.core.removePrincipalFromSpace(ctx.space.id, params.principalId),
  );
  return { removed };
}

async function memberResolveByEmail(
  params: MemberResolveByEmailParams,
  context: HandlerContext,
): Promise<MemberResolveByEmailResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  requireSpaceManager(ctx);
  const principal = await ctx.core.getUserByName(params.email);
  return { principal: principal ? toPrincipalResponse(principal) : null };
}

export const memberMethods = buildRegistry()
  .register("member.list", memberListParams, memberList)
  .register("member.add", memberAddParams, memberAdd)
  .register("member.remove", memberRemoveParams, memberRemove)
  .register(
    "member.resolveByEmail",
    memberResolveByEmailParams,
    memberResolveByEmail,
  )
  .build();
