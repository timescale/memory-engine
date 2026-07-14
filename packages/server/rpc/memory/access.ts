/** Effective access introspection handlers (access.*). */
import type {
  AccessEffectiveParams,
  AccessEffectiveResult,
  AccessLevel,
  EffectiveAccessAuthenticatedAs,
  EffectiveAccessEntry,
  EffectiveAccessPrincipal,
} from "@memory.build/protocol/space";
import {
  accessEffectiveParams,
  accessLevelName,
} from "@memory.build/protocol/space";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import {
  callerAdministersServiceAccount,
  callerOwnsAgent,
  displayTreePath,
} from "./support";
import { assertSpaceRpcContext, type SpaceRpcContext } from "./types";

function toEffectiveAccessEntry(
  ctx: SpaceRpcContext,
  row: { tree_path: string; access: number },
): EffectiveAccessEntry {
  const access = row.access as AccessLevel;
  return {
    treePath: displayTreePath(ctx, row.tree_path),
    access,
    accessName: accessLevelName(access),
  };
}

function assertExecutableKind(kind: string): asserts kind is "u" | "a" | "s" {
  if (kind === "g") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Groups have raw grants, not effective access as an executable principal",
    );
  }
  if (kind !== "u" && kind !== "a" && kind !== "s") {
    throw new AppError("VALIDATION_ERROR", "Invalid principal kind");
  }
}

async function currentPrincipal(
  ctx: SpaceRpcContext,
): Promise<EffectiveAccessPrincipal> {
  const principal = await ctx.core.getPrincipal(ctx.principalId);
  if (!principal) {
    throw new AppError("NOT_FOUND", `Principal not found: ${ctx.principalId}`);
  }
  assertExecutableKind(principal.kind);
  return {
    id: principal.id,
    kind: principal.kind,
    name: principal.name,
    ownerId: principal.ownerId,
    admin: ctx.admin,
  };
}

async function authenticatedAs(
  ctx: SpaceRpcContext,
): Promise<EffectiveAccessAuthenticatedAs | null> {
  if (!ctx.authenticatedAs) return null;
  const principal = await ctx.core.getPrincipal(ctx.authenticatedAs);
  if (!principal) return null;
  assertExecutableKind(principal.kind);
  return { id: principal.id, kind: principal.kind, name: principal.name };
}

async function targetPrincipal(
  ctx: SpaceRpcContext,
  principalId: string,
): Promise<EffectiveAccessPrincipal> {
  const principal = await ctx.core.getPrincipal(principalId);
  if (
    !principal ||
    !(await ctx.core.isPrincipalInSpace(principalId, ctx.space.id))
  ) {
    throw new AppError(
      "NOT_FOUND",
      `Principal not found in this space: ${principalId}`,
    );
  }
  assertExecutableKind(principal.kind);
  return {
    id: principal.id,
    kind: principal.kind,
    name: principal.name,
    ownerId: principal.ownerId,
    admin: await ctx.core.isSpaceAdmin(principal.id, ctx.space.id),
  };
}

async function requireEffectiveAccessInspection(
  ctx: SpaceRpcContext,
  principalId: string,
): Promise<void> {
  if (principalId === ctx.principalId) return;
  if (ctx.admin) return;
  if (await callerOwnsAgent(ctx, principalId)) return;
  if (await callerAdministersServiceAccount(ctx, principalId)) return;
  throw new AppError(
    "FORBIDDEN",
    "Inspecting another principal's effective access requires being a space admin or managing that principal",
  );
}

async function accessEffective(
  params: AccessEffectiveParams,
  context: HandlerContext,
): Promise<AccessEffectiveResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const principalId = params.principalId ?? ctx.principalId;
  const isCurrent = principalId === ctx.principalId;

  await requireEffectiveAccessInspection(ctx, principalId);

  const principal = isCurrent
    ? await currentPrincipal(ctx)
    : await targetPrincipal(ctx, principalId);

  const treeAccess = isCurrent
    ? ctx.treeAccess
    : await ctx.core.buildTreeAccess(principal.id, ctx.space.id);

  return {
    space: { id: ctx.space.id, slug: ctx.space.slug, name: ctx.space.name },
    principal,
    authenticatedAs: await authenticatedAs(ctx),
    access: treeAccess.map((row) => toEffectiveAccessEntry(ctx, row)),
  };
}

export const accessMethods = buildRegistry()
  .register("access.effective", accessEffectiveParams, accessEffective)
  .build();
