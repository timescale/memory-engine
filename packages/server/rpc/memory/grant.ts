/**
 * Tree-access grant handlers (grant.*). Three additive levels
 * (1 = read, 2 = write, 3 = owner); owner listing is grant.list filtered to 3.
 */
import type {
  GrantListParams,
  GrantListResult,
  GrantRemoveParams,
  GrantRemoveResult,
  GrantSetParams,
  GrantSetResult,
} from "@memory.build/protocol/space";
import {
  grantListParams,
  grantRemoveParams,
  grantSetParams,
} from "@memory.build/protocol/space";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import {
  callerOwnsAgent,
  guardCore,
  inputTreePath,
  isSpaceManager,
  ownsTreePath,
  requireSpaceManager,
  requireTreeOwner,
  toTreeGrantResponse,
} from "./support";
import { assertSpaceRpcContext, type SpaceRpcContext } from "./types";

/**
 * Authority to grant/remove access at a path. Allowed when any of:
 *  - the target is the caller's OWN agent (self-service — capped anyway);
 *  - the caller is a space admin / owner;
 *  - the caller owns the tree path (owning a subtree delegates control within it).
 */
async function requireGrantAuthority(
  ctx: SpaceRpcContext,
  principalId: string,
  treePath: string,
): Promise<void> {
  if (await callerOwnsAgent(ctx, principalId)) return;
  if (isSpaceManager(ctx)) return;
  requireTreeOwner(ctx, treePath);
}

async function grantSet(
  params: GrantSetParams,
  context: HandlerContext,
): Promise<GrantSetResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const treePath = inputTreePath(ctx, params.treePath);
  await requireGrantAuthority(ctx, params.principalId, treePath);
  await guardCore(() =>
    ctx.core.grantTreeAccess(
      ctx.space.id,
      params.principalId,
      treePath,
      params.access,
    ),
  );
  return { granted: true };
}

async function grantRemove(
  params: GrantRemoveParams,
  context: HandlerContext,
): Promise<GrantRemoveResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const treePath = inputTreePath(ctx, params.treePath);
  await requireGrantAuthority(ctx, params.principalId, treePath);
  const removed = await guardCore(() =>
    ctx.core.removeTreeAccessGrant(ctx.space.id, params.principalId, treePath),
  );
  return { removed };
}

async function grantList(
  params: GrantListParams,
  context: HandlerContext,
): Promise<GrantListResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const treePath =
    params.treePath !== undefined && params.treePath !== null
      ? inputTreePath(ctx, params.treePath)
      : undefined;
  // Authorized when listing your OWN agent's grants, or a subtree you own, or
  // (broadly) as a space manager.
  const ownAgent =
    params.principalId !== undefined &&
    params.principalId !== null &&
    (await callerOwnsAgent(ctx, params.principalId));
  const pathOwner = treePath !== undefined && ownsTreePath(ctx, treePath);
  if (!ownAgent && !pathOwner) {
    requireSpaceManager(ctx);
  }
  const grants = await ctx.core.listTreeAccessGrants(
    ctx.space.id,
    params.principalId ?? undefined,
    treePath,
  );
  return { grants: grants.map((g) => toTreeGrantResponse(g, ctx)) };
}

export const grantMethods = buildRegistry()
  .register("grant.set", grantSetParams, grantSet)
  .register("grant.remove", grantRemoveParams, grantRemove)
  .register("grant.list", grantListParams, grantList)
  .build();
