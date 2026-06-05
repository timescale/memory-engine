/**
 * Space membership handlers (principal.*) — the space roster (principal_space).
 */
import type {
  PrincipalAddParams,
  PrincipalAddResult,
  PrincipalListParams,
  PrincipalListResult,
  PrincipalLookupParams,
  PrincipalLookupResult,
  PrincipalRemoveParams,
  PrincipalRemoveResult,
  PrincipalResolveParams,
  PrincipalResolveResult,
} from "@memory.build/protocol/space";
import {
  principalAddParams,
  principalListParams,
  principalLookupParams,
  principalRemoveParams,
  principalResolveParams,
} from "@memory.build/protocol/space";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import {
  callerOwnsAgentGlobal,
  guardCore,
  requireSpaceAdmin,
  toSpacePrincipalResponse,
} from "./support";
import { assertSpaceRpcContext, type SpaceRpcContext } from "./types";

async function principalList(
  params: PrincipalListParams,
  context: HandlerContext,
): Promise<PrincipalListResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  // Enumerating the whole roster is structural — admin only. (Targeted name / id
  // lookups for any member are principal.resolve / principal.lookup.)
  requireSpaceAdmin(ctx);
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

async function principalResolve(
  params: PrincipalResolveParams,
  context: HandlerContext,
): Promise<PrincipalResolveResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  // No authority gate beyond space participation: reaching this handler means the
  // caller has access in this space (the authenticate-space membership gate). This
  // is a targeted name->id lookup, not roster enumeration (that is principal.list).
  const principals = await ctx.core.listSpacePrincipals(
    ctx.space.id,
    params.kind ?? undefined,
  );
  const lower = params.name.trim().toLowerCase();
  const matches = principals
    .filter((p) => p.name.toLowerCase() === lower)
    .map((p) => ({ id: p.id, kind: p.kind, name: p.name }));
  return { principals: matches };
}

async function principalLookup(
  params: PrincipalLookupParams,
  context: HandlerContext,
): Promise<PrincipalLookupResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  // Member-accessible reverse lookup (id -> name/kind) for display; only ids that
  // are in the space come back. Same gating rationale as principalResolve.
  const ids = new Set(params.ids);
  if (ids.size === 0) return { principals: [] };
  const principals = await ctx.core.listSpacePrincipals(ctx.space.id);
  const found = principals
    .filter((p) => ids.has(p.id))
    .map((p) => ({ id: p.id, kind: p.kind, name: p.name }));
  return { principals: found };
}

export const principalMethods = buildRegistry()
  .register("principal.list", principalListParams, principalList)
  .register("principal.add", principalAddParams, principalAdd)
  .register("principal.remove", principalRemoveParams, principalRemove)
  .register("principal.resolve", principalResolveParams, principalResolve)
  .register("principal.lookup", principalLookupParams, principalLookup)
  .build();
