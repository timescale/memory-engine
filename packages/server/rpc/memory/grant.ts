/**
 * Tree-access grant handlers (grant.*). Three additive levels
 * (1 = read, 2 = write, 3 = owner); owner listing is grant.list filtered to 3.
 */
import { ROOT_PATH } from "@memory.build/engine/core";
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
  ownsTreePath,
  requireSpaceAdmin,
  requireTreeOwner,
  toTreeGrantResponse,
} from "./support";
import { assertSpaceRpcContext, type SpaceRpcContext } from "./types";

/**
 * Authority to grant/remove access at a path. Allowed when any of:
 *  - the target is the caller's OWN agent (self-service — capped anyway);
 *  - the caller is a space admin (admins manage all access);
 *  - the caller owns the path or an ancestor (owner@root owns the whole tree).
 */
async function requireGrantAuthority(
  ctx: SpaceRpcContext,
  principalId: string,
  treePath: string,
): Promise<void> {
  if (await callerOwnsAgent(ctx, principalId)) return;
  if (ctx.admin) return;
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
  // No path filter means the whole space, i.e. the root path. Listing grants
  // under a path requires owning that path (root → owning the whole space),
  // else space-admin. Self-service paths (no admin/owner needed): listing your
  // own grants (powers `me access mine`), or those of an agent you own — both
  // keep the principal filter pinned to you (self) or your owned agent, so they
  // can't reveal another principal's grants.
  const under =
    params.treePath !== undefined && params.treePath !== null
      ? inputTreePath(ctx, params.treePath)
      : ROOT_PATH;
  const ownSelf =
    params.principalId !== undefined &&
    params.principalId !== null &&
    params.principalId === ctx.principalId;
  const ownAgent =
    params.principalId !== undefined &&
    params.principalId !== null &&
    (await callerOwnsAgent(ctx, params.principalId));
  if (!ownSelf && !ownAgent && !ownsTreePath(ctx, under)) {
    requireSpaceAdmin(ctx);
  }
  const grants = await ctx.core.listTreeAccessGrants(
    ctx.space.id,
    params.principalId ?? undefined,
    under,
  );
  return { grants: grants.map((g) => toTreeGrantResponse(g, ctx)) };
}

export const grantMethods = buildRegistry()
  .register("grant.set", grantSetParams, grantSet)
  .register("grant.remove", grantRemoveParams, grantRemove)
  .register("grant.list", grantListParams, grantList)
  .build();
