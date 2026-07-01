/**
 * Shared helpers for the space management handlers (member/group/grant/invite):
 * the owner authorization gate, core SQL error mapping, and response
 * serializers.
 */

import {
  classifyTreeFilter,
  denormalizeTreePath,
  normalizeTreePath,
  type TreeFilter,
  TreePathError,
  type TreePathOptions,
} from "@memory.build/database";
import type {
  Group,
  GroupMember,
  GroupMembership,
  SpaceInvitation,
  SpacePrincipal,
  TreeGrant,
} from "@memory.build/engine/core";
import { ACCESS, ROOT_PATH } from "@memory.build/engine/core";
import type {
  GroupMemberResponse,
  GroupMembershipResponse,
  GroupResponse,
  SpaceInvitationResponse,
  SpacePrincipalResponse,
  TreeGrantResponse,
} from "@memory.build/protocol/space";
import { guardCore } from "../core-error";
import { AppError } from "../errors";
import type { SpaceRpcContext } from "./types";

export { guardCore };

// =============================================================================
// Tree-path normalization at the user-facing boundary
// =============================================================================

/**
 * The caller's `~` home expansion: `home.<userId>` for a user, or
 * `home.<ownerId>.<agentId>` for an agent (nested under its owner's home).
 */
function homeOpts(ctx: SpaceRpcContext): TreePathOptions {
  return { home: ctx.principalId, homeOwner: ctx.ownerId ?? undefined };
}

/**
 * Normalize a concrete tree path from the wire to canonical ltree, expanding a
 * leading `~` to the caller's home. Maps malformed input to a validation error.
 */
export function inputTreePath(ctx: SpaceRpcContext, raw: string): string {
  try {
    return normalizeTreePath(raw, homeOpts(ctx));
  } catch (e) {
    throw asValidationError(e);
  }
}

/**
 * Like `inputTreePath` but for a search filter: normalizes `~`/slashes and
 * classifies the result as an ltree path, an `lquery` pattern, or an
 * `ltxtquery` label search, so the handler can bind the right SQL parameter.
 * Returns `null` when there is no filter.
 */
export function inputTreeFilter(
  ctx: SpaceRpcContext,
  raw: string,
): TreeFilter | null {
  try {
    return classifyTreeFilter(raw, homeOpts(ctx));
  } catch (e) {
    throw asValidationError(e);
  }
}

/** Reverse the home expansion for display: the caller's home shows as `~/…`. */
export function displayTreePath(ctx: SpaceRpcContext, stored: string): string {
  return denormalizeTreePath(stored, homeOpts(ctx));
}

function asValidationError(e: unknown): AppError {
  if (e instanceof TreePathError) {
    return new AppError("VALIDATION_ERROR", e.message);
  }
  return e instanceof AppError
    ? e
    : new AppError("VALIDATION_ERROR", "Invalid tree path");
}

/**
 * Structural authority over the space (principal_space.admin). Required for
 * managing groups — a structural construct of the space, distinct from data
 * ownership: owning the data tree (owner@root) is NOT sufficient.
 */
export function requireSpaceAdmin(context: SpaceRpcContext): void {
  if (!context.admin) {
    throw new AppError("FORBIDDEN", "This action requires being a space admin");
  }
}

/**
 * Authority to manage a group's membership: a space admin, or an admin of the
 * group itself (group_member.admin). Used by group.addMember / removeMember /
 * listMembers. (Creating/renaming/deleting groups stays space-admin only.)
 */
export async function requireGroupAdmin(
  context: SpaceRpcContext,
  groupId: string,
): Promise<void> {
  if (context.admin) return;
  const groupAdmin = await context.core.isGroupAdmin(
    context.principalId,
    groupId,
    context.space.id,
  );
  if (!groupAdmin) {
    throw new AppError(
      "FORBIDDEN",
      "Managing group members requires being a space admin or an admin of the group",
    );
  }
}

/** True if `ancestor` is an ancestor-or-self of `path` (ltree `@>`). */
function isAncestorOrSelf(ancestor: string, path: string): boolean {
  return (
    ancestor === ROOT_PATH ||
    path === ancestor ||
    path.startsWith(`${ancestor}.`)
  );
}

/**
 * Owner authority at a specific tree path: the caller holds an owner grant (3)
 * at the path or any ancestor of it. This is how grants are delegated — owning
 * a subtree lets you manage access within it. Owner@root is the case that
 * covers the whole space.
 */
export function ownsTreePath(
  context: SpaceRpcContext,
  treePath: string,
): boolean {
  return context.treeAccess.some(
    (g) => g.access >= ACCESS.owner && isAncestorOrSelf(g.tree_path, treePath),
  );
}

export function requireTreeOwner(
  context: SpaceRpcContext,
  treePath: string,
): void {
  if (!ownsTreePath(context, treePath)) {
    throw new AppError(
      "FORBIDDEN",
      `Granting access at "${treePath}" requires owner access on that path`,
    );
  }
}

/**
 * True if `principalId` is an agent in this space owned by the caller. Agents
 * are user-owned and capped by their owner's access (agent_tree_access), so a
 * member managing their own agents (create/keys/self-grants) is self-service
 * and safe — it can't escalate beyond the caller's own access.
 */
export async function callerOwnsAgent(
  context: SpaceRpcContext,
  principalId: string,
): Promise<boolean> {
  const agents = await context.core.listSpacePrincipals(context.space.id, "a");
  const agent = agents.find((a) => a.id === principalId);
  return agent !== undefined && agent.ownerId === context.principalId;
}

/**
 * True if `principalId` is an agent owned by the caller, checked globally (not
 * scoped to the current space). Used by principal.add so a member can bring
 * their OWN agent into a space before it is a member there.
 */
export async function callerOwnsAgentGlobal(
  context: SpaceRpcContext,
  principalId: string,
): Promise<boolean> {
  const principal = await context.core.getPrincipal(principalId);
  return (
    principal !== null &&
    principal.kind === "a" &&
    principal.ownerId === context.principalId
  );
}

// =============================================================================
// Serializers (Date → ISO)
// =============================================================================

export function toSpacePrincipalResponse(
  m: SpacePrincipal,
): SpacePrincipalResponse {
  return {
    id: m.id,
    kind: m.kind,
    name: m.name,
    ownerId: m.ownerId,
    admin: m.admin,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt?.toISOString() ?? null,
  };
}

export function toGroupResponse(g: Group): GroupResponse {
  return {
    id: g.id,
    name: g.name,
    isSpaceAdmin: g.isSpaceAdmin,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt?.toISOString() ?? null,
  };
}

export function toGroupMemberResponse(m: GroupMember): GroupMemberResponse {
  return {
    memberId: m.memberId,
    kind: m.kind,
    name: m.name,
    admin: m.admin,
    createdAt: m.createdAt.toISOString(),
  };
}

export function toGroupMembershipResponse(
  m: GroupMembership,
): GroupMembershipResponse {
  return {
    groupId: m.groupId,
    name: m.name,
    admin: m.admin,
    createdAt: m.createdAt.toISOString(),
  };
}

export function toTreeGrantResponse(
  g: TreeGrant,
  ctx: SpaceRpcContext,
): TreeGrantResponse {
  return {
    principalId: g.principalId,
    treePath: displayTreePath(ctx, g.treePath),
    access: g.access,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt?.toISOString() ?? null,
  };
}

export function toSpaceInvitationResponse(
  i: SpaceInvitation,
): SpaceInvitationResponse {
  return {
    id: i.id,
    email: i.email,
    kind: i.kind,
    admin: i.admin,
    groupIds: i.groupIds,
    groupNames: i.groupNames,
    invitedBy: i.invitedBy,
    invitedByName: i.invitedByName,
    expiresAt: i.expiresAt?.toISOString() ?? null,
    maxUses: i.maxUses,
    uses: i.uses,
    valid: i.valid,
    token: i.token,
    createdAt: i.createdAt.toISOString(),
  };
}
