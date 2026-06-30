/**
 * Space handlers (space.*) for the user RPC.
 *
 * User-scoped space discovery: the spaces the calling user belongs to. The CLI
 * uses this to pick the X-Me-Space that scopes the rest of its commands.
 */
import {
  generateSlug,
  provisionSpace,
  slugToSchema,
} from "@memory.build/database";
import {
  coreStore,
  type MemberSpace,
  type Space,
} from "@memory.build/engine/core";
import type {
  MemberSpaceResponse,
  SpaceCreateParams,
  SpaceCreateResult,
  SpaceDeleteParams,
  SpaceDeleteResult,
  SpaceEnsureDefaultParams,
  SpaceEnsureDefaultResult,
  SpaceListParams,
  SpaceListResult,
  SpaceRenameParams,
  SpaceRenameResult,
} from "@memory.build/protocol/user";
import {
  spaceCreateParams,
  spaceDeleteParams,
  spaceEnsureDefaultParams,
  spaceListParams,
  spaceRenameParams,
} from "@memory.build/protocol/user";
import type { Sql } from "postgres";
import { addSpaceCreator } from "../../provision";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { assertUserRpcContext, type UserRpcContext } from "./types";

/** Resolve a space by slug and require the caller to be its admin. */
async function requireSpaceAdminFor(
  ctx: UserRpcContext,
  slug: string,
): Promise<Space> {
  const space = await ctx.core.getSpace(slug);
  if (!space) {
    throw new AppError("NOT_FOUND", `Space not found: ${slug}`);
  }
  if (!(await ctx.core.isSpaceAdmin(ctx.userId, space.id))) {
    throw new AppError("FORBIDDEN", "This action requires being a space admin");
  }
  return space;
}

export function toMemberSpaceResponse(s: MemberSpace): MemberSpaceResponse {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    language: s.language,
    admin: s.admin,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt?.toISOString() ?? null,
  };
}

async function spaceList(
  _params: SpaceListParams,
  context: HandlerContext,
): Promise<SpaceListResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  const spaces = await ctx.core.listSpacesForMember(ctx.userId);
  return { spaces: spaces.map(toMemberSpaceResponse) };
}

/**
 * Provision a brand-new space + its creator grants inside a transaction: the
 * core.space row, the me_<slug> data schema, the creator's membership, and the
 * owner@home + owner@share grants. The creator becomes a space admin and owner of
 * its own home and the shared root (`share`) — but NOT owner@root, so it sees
 * `/share` and `~` but not other members' homes. Shared by `space.create` and
 * `space.ensureDefault` so the two stay in lockstep. Returns the new space id.
 */
async function provisionSpaceWithCreator(
  tx: Sql,
  coreSchema: string,
  userId: string,
  slug: string,
  name: string,
): Promise<string> {
  const core = coreStore(tx as unknown as Sql, coreSchema);
  const spaceId = await core.createSpace(slug, name);
  await provisionSpace(tx, { slug }); // creates the me_<slug> data schema
  await addSpaceCreator(core, spaceId, userId);
  return spaceId;
}

/**
 * Create a new space. Atomic: the core.space row, the me_<slug> data schema, the
 * membership, and the creator grants all land in one transaction (any failure
 * rolls the schema back).
 */
async function spaceCreate(
  params: SpaceCreateParams,
  context: HandlerContext,
): Promise<SpaceCreateResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  const slug = generateSlug();

  const id = (await ctx.db.begin((tx) =>
    provisionSpaceWithCreator(
      tx as unknown as Sql,
      ctx.coreSchema,
      ctx.userId,
      slug,
      params.name,
    ),
  )) as string;

  return { id, slug };
}

/**
 * Create a personal "default" space ONLY when the caller has zero memberships; a
 * no-op otherwise. Default-space provisioning is NOT done lazily in middleware
 * anymore — the onboarding entry points (CLI `me login`, web AuthGate) call this
 * when `space.list` is empty, so a user who joins via an accepted invitation or a
 * redeemed magic link never gets a junk personal space. The zero-membership check
 * is re-run inside the transaction to stay safe under concurrent first-requests.
 */
async function spaceEnsureDefault(
  _params: SpaceEnsureDefaultParams,
  context: HandlerContext,
): Promise<SpaceEnsureDefaultResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;

  if ((await ctx.core.listSpacesForMember(ctx.userId)).length > 0) {
    return { created: false, space: null };
  }

  const slug = generateSlug();
  const created = (await ctx.db.begin(async (tx) => {
    const core = coreStore(tx as unknown as Sql, ctx.coreSchema);
    // Re-check inside the transaction: a concurrent call may have created one.
    if ((await core.listSpacesForMember(ctx.userId)).length > 0) return false;
    await provisionSpaceWithCreator(
      tx as unknown as Sql,
      ctx.coreSchema,
      ctx.userId,
      slug,
      "default",
    );
    return true;
  })) as boolean;

  if (!created) return { created: false, space: null };
  const space =
    (await ctx.core.listSpacesForMember(ctx.userId)).find(
      (s) => s.slug === slug,
    ) ?? null;
  return {
    created: space !== null,
    space: space ? toMemberSpaceResponse(space) : null,
  };
}

/** Rename a space's display name (admin only); the slug is immutable. */
async function spaceRename(
  params: SpaceRenameParams,
  context: HandlerContext,
): Promise<SpaceRenameResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  await requireSpaceAdminFor(ctx, params.slug);
  const renamed = await ctx.core.renameSpace(params.slug, params.name);
  return { renamed };
}

/**
 * Delete a space (admin only): drop its core row (cascading memberships/groups/
 * grants) and its me_<slug> data schema, atomically.
 */
async function spaceDelete(
  params: SpaceDeleteParams,
  context: HandlerContext,
): Promise<SpaceDeleteResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  const space = await requireSpaceAdminFor(ctx, params.slug);

  const deleted = (await ctx.db.begin(async (tx) => {
    const core = coreStore(tx as unknown as Sql, ctx.coreSchema);
    const ok = await core.deleteSpace(space.slug);
    // slug came from the DB (validated by the slug check constraint); safe to
    // interpolate into the DDL.
    await tx.unsafe(
      `drop schema if exists ${slugToSchema(space.slug)} cascade`,
    );
    return ok;
  })) as boolean;

  return { deleted };
}

export const spaceMethods = buildRegistry()
  .register("space.list", spaceListParams, spaceList)
  .register("space.create", spaceCreateParams, spaceCreate)
  .register("space.ensureDefault", spaceEnsureDefaultParams, spaceEnsureDefault)
  .register("space.rename", spaceRenameParams, spaceRename)
  .register("space.delete", spaceDeleteParams, spaceDelete)
  .build();
