/**
 * Space handlers (space.*) for the user RPC.
 *
 * User-scoped space discovery: the spaces the calling user belongs to. The CLI
 * uses this to pick the X-Me-Space that scopes the rest of its commands.
 */
import { generateSlug, provisionSpace } from "@memory.build/database";
import {
  ACCESS,
  coreStore,
  type MemberSpace,
  ROOT_PATH,
} from "@memory.build/engine/core";
import type {
  MemberSpaceResponse,
  SpaceCreateParams,
  SpaceCreateResult,
  SpaceListParams,
  SpaceListResult,
} from "@memory.build/protocol/user";
import {
  spaceCreateParams,
  spaceListParams,
} from "@memory.build/protocol/user";
import type { Sql } from "postgres";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { assertUserRpcContext, type UserRpcContext } from "./types";

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

export const spaceMethods = buildRegistry()
  .register("space.list", spaceListParams, spaceList)
  .register("space.create", spaceCreateParams, spaceCreate)
  .build();
