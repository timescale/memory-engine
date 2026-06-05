/**
 * Space membership handlers (principal.*) — the space roster (principal_space).
 */
import type {
  PrincipalAddParams,
  PrincipalAddResult,
  PrincipalListParams,
  PrincipalListResult,
  PrincipalRemoveParams,
  PrincipalRemoveResult,
  PrincipalResolveByEmailParams,
  PrincipalResolveByEmailResult,
} from "@memory.build/protocol/space";
import {
  principalAddParams,
  principalListParams,
  principalRemoveParams,
  principalResolveByEmailParams,
} from "@memory.build/protocol/space";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import {
  callerOwnsAgentGlobal,
  guardCore,
  requireSpaceAdmin,
  requireSpaceManager,
  toPrincipalResponse,
  toSpacePrincipalResponse,
} from "./support";
import { assertSpaceRpcContext, type SpaceRpcContext } from "./types";

async function principalList(
  params: PrincipalListParams,
  context: HandlerContext,
): Promise<PrincipalListResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  requireSpaceManager(ctx);
  const principals = await ctx.core.listSpacePrincipals(
    ctx.space.id,
    params.kind ?? undefined,
  );
  return { principals: principals.map(toSpacePrincipalResponse) };
}

async function principalAdd(
  params: PrincipalAddParams,
  context: HandlerContext,
): Promise<PrincipalAddResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  // Bringing your OWN agent into a space is self-service (it stays capped by
  // your access); adding anyone else is a structural roster change that requires
  // space-admin (owner@root is not enough). A member can't grant themselves admin
  // on their own agent membership.
  const ownAgent =
    params.admin !== true &&
    (await callerOwnsAgentGlobal(ctx, params.principalId));
  if (!ownAgent) {
    requireSpaceAdmin(ctx);
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

async function principalRemove(
  params: PrincipalRemoveParams,
  context: HandlerContext,
): Promise<PrincipalRemoveResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  // Removing a roster member is structural, like adding — space-admin only.
  requireSpaceAdmin(ctx);
  const removed = await guardCore(() =>
    ctx.core.removePrincipalFromSpace(ctx.space.id, params.principalId),
  );
  return { removed };
}

async function principalResolveByEmail(
  params: PrincipalResolveByEmailParams,
  context: HandlerContext,
): Promise<PrincipalResolveByEmailResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  requireSpaceManager(ctx);
  const principal = await ctx.core.getUserByName(params.email);
  return { principal: principal ? toPrincipalResponse(principal) : null };
}

export const principalMethods = buildRegistry()
  .register("principal.list", principalListParams, principalList)
  .register("principal.add", principalAddParams, principalAdd)
  .register("principal.remove", principalRemoveParams, principalRemove)
  .register(
    "principal.resolveByEmail",
    principalResolveByEmailParams,
    principalResolveByEmail,
  )
  .build();
