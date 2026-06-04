/**
 * Space handlers (space.*) for the user RPC.
 *
 * User-scoped space discovery: the spaces the calling user belongs to. The CLI
 * uses this to pick the X-Me-Space that scopes the rest of its commands.
 */
import type { MemberSpace } from "@memory.build/engine/core";
import type {
  MemberSpaceResponse,
  SpaceListParams,
  SpaceListResult,
} from "@memory.build/protocol/user";
import { spaceListParams } from "@memory.build/protocol/user";
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

export const spaceMethods = buildRegistry()
  .register("space.list", spaceListParams, spaceList)
  .build();
