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
  // Removing a roster member is structural — space-admin only — with two
  // self-service exceptions that mirror `principal.add`'s own-agent carve-out:
  //   (a) a member removing THEIR OWN agent (inverse of `me agent add`), and
  //   (b) a USER removing THEMSELVES (`me space leave`).
  // Kind detection uses `ctx.ownerId` as a discriminator on the AUTHENTICATED
  // PRINCIPAL (not the credential): it is null when that principal is a user and
  // non-null only when it is an agent. This holds after any X-Me-As-Agent
  // switch — a human acting as their own agent has `ctx.principalId`/`ctx.ownerId`
  // overwritten to the agent (owner non-null), so they are correctly treated as
  // the agent (the parity invariant) and fall through to the admin gate, exactly
  // as that agent's own key would. (ownerId's primary role is `~`-home nesting;
  // it doubles as a user/agent signal because agents are the only owned principal
  // and no principal authenticates as a group.) An agent removing itself is thus
  // intentionally NOT covered here — its owner removes it via `me agent remove`.
  // `LAST_ADMIN` still protects a sole admin (the deferred trigger, mapped by
  // guardCore).
  //
  // The allow set is `isSelfUser || admin || ownAgent`. Evaluate the two cheap
  // in-context checks first and only fall back to the own-agent carve-out — a
  // `getPrincipal` round-trip — for a non-self, non-admin removal, so the common
  // admin remove-member and self-leave paths pay no extra query.
  const isSelfUser =
    params.principalId === ctx.principalId && ctx.ownerId === null;
  if (!isSelfUser && !ctx.admin) {
    const ownAgent = await callerOwnsAgentGlobal(ctx, params.principalId);
    // Not self, not admin, not the caller's own agent → structural, denied.
    if (!ownAgent) requireSpaceAdmin(ctx);
  }
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
