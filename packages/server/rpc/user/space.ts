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
  ACCESS,
  coreStore,
  type MemberSpace,
  ROOT_PATH,
  type Space,
} from "@memory.build/engine/core";
import type {
  MemberSpaceResponse,
  SpaceCreateParams,
  SpaceCreateResult,
  SpaceDeleteParams,
  SpaceDeleteResult,
  SpaceListParams,
  SpaceListResult,
  SpaceRenameParams,
  SpaceRenameResult,
} from "@memory.build/protocol/user";
import {
  spaceCreateParams,
  spaceDeleteParams,
  spaceListParams,
  spaceRenameParams,
} from "@memory.build/protocol/user";
import type { Sql } from "postgres";
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

function toMemberSpaceResponse(s: MemberSpace): MemberSpaceResponse {
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
 * Create a new space and make the calling user its admin + owner of the root.
 * Atomic: the core.space row, the me_<slug> data schema, the membership, and the
 * owner grant all land in one transaction (any failure rolls the schema back).
 * The new space starts with an empty tree.
 */
async function spaceCreate(
  params: SpaceCreateParams,
  context: HandlerContext,
): Promise<SpaceCreateResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  const slug = generateSlug();

  const id = (await ctx.db.begin(async (tx) => {
    const core = coreStore(tx as unknown as Sql, ctx.coreSchema);
    const spaceId = await core.createSpace(slug, params.name);
    await provisionSpace(tx, { slug }); // creates the me_<slug> data schema
    await core.addPrincipalToSpace(spaceId, ctx.userId, true);
    await core.grantTreeAccess(spaceId, ctx.userId, ROOT_PATH, ACCESS.owner);
    return spaceId;
  })) as string;

  return { id, slug };
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
  .register("space.rename", spaceRenameParams, spaceRename)
  .register("space.delete", spaceDeleteParams, spaceDelete)
  .build();
