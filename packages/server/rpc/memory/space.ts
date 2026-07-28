/** Active-space helpers (space.*) served on the memory RPC endpoint. */
import type {
  SpaceListMembersParams,
  SpaceListMembersResult,
  SpaceMemberKind,
} from "@memory.build/protocol/space";
import { spaceListMembersParams } from "@memory.build/protocol/space";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { assertSpaceRpcContext, type SpaceRpcContext } from "./types";

const MEMBER_KINDS: Array<"u" | "s"> = ["u", "s"];

async function spaceListMembers(
  params: SpaceListMembersParams,
  context: HandlerContext,
): Promise<SpaceListMembersResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;

  const kind = params.kind;
  const kinds: Array<"u" | "s"> =
    kind === "u" ? ["u"] : kind === "s" ? ["s"] : MEMBER_KINDS;
  const members = (
    await Promise.all(
      kinds.map((kind) => ctx.core.listSpacePrincipals(ctx.space.id, kind)),
    )
  ).flat();

  return {
    members: members.map((m) => ({
      id: m.id,
      kind: m.kind as SpaceMemberKind,
      name: m.name,
    })),
  };
}

export const activeSpaceMethods = buildRegistry()
  .register("space.listMembers", spaceListMembersParams, spaceListMembers)
  .build();
