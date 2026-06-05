/**
 * Shared helpers for the space management handlers (member/agent/group/grant/
 * apiKey): the owner authorization gate, core SQL error mapping, and response
 * serializers.
 */

import {
  denormalizeTreePath,
  normalizeTreeFilter,
  normalizeTreePath,
  TreePathError,
} from "@memory.build/database";
import type {
  ApiKeyInfo,
  Group,
  GroupMember,
  GroupMembership,
  Principal,
  SpaceInvitation,
  SpacePrincipal,
  TreeGrant,
} from "@memory.build/engine/core";
import { ACCESS, ROOT_PATH } from "@memory.build/engine/core";
import type {
  ApiKeyInfoResponse,
  GroupMemberResponse,
  GroupMembershipResponse,
  GroupResponse,
  PrincipalResponse,
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
 * Normalize a concrete tree path from the wire to canonical ltree, expanding a
 * leading `~` to the caller's home. Maps malformed input to a validation error.
 */
export function inputTreePath(ctx: SpaceRpcContext, raw: string): string {
  try {
    return normalizeTreePath(raw, { home: ctx.principalId });
  } catch (e) {
    throw asValidationError(e);
  }
}

/** Like `inputTreePath` but for a search filter (lquery/ltxtquery passes through). */
export function inputTreeFilter(ctx: SpaceRpcContext, raw: string): string {
  try {
    return normalizeTreeFilter(raw, { home: ctx.principalId });
  } catch (e) {
    throw asValidationError(e);
  }
}

/** Reverse the home expansion for display: the caller's home shows as `~/…`. */
export function displayTreePath(ctx: SpaceRpcContext, stored: string): string {
  return denormalizeTreePath(stored, { home: ctx.principalId });
}

function asValidationError(e: unknown): AppError {
  if (e instanceof TreePathError) {
    return new AppError("VALIDATION_ERROR", e.message);
  }
  return e instanceof AppError
    ? e
    : new AppError("VALIDATION_ERROR", "Invalid tree path");
}

/** Owner-level grant (3) at the space root — owns the whole space. */
export function isSpaceOwner(context: SpaceRpcContext): boolean {
  return context.treeAccess.some(
    (g) => g.tree_path === ROOT_PATH && g.access >= ACCESS.owner,
  );
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

/**
 * Space-management authority: a space admin (principal_space.admin) or the
 * space owner (owner@root). Gates roster management and broad grant listing —
 * controlling access to data the owner owns. (Per-subtree grant delegation is
 * handled by requireTreeOwner; group structure requires requireSpaceAdmin.)
 */
export function isSpaceManager(context: SpaceRpcContext): boolean {
  return context.admin || isSpaceOwner(context);
}

export function requireSpaceManager(context: SpaceRpcContext): void {
  if (!isSpaceManager(context)) {
    throw new AppError(
      "FORBIDDEN",
      "Space management requires being a space admin or owner",
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
 * Assert the caller owns `agentId` (an agent in this space). NOT_FOUND if the
 * agent isn't a member of this space; FORBIDDEN if it's owned by someone else.
 */
export async function requireOwnedAgent(
  context: SpaceRpcContext,
  agentId: string,
): Promise<void> {
  const agents = await context.core.listSpacePrincipals(context.space.id, "a");
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) {
    throw new AppError(
      "NOT_FOUND",
      `Agent not found in this space: ${agentId}`,
    );
  }
  if (agent.ownerId !== context.principalId) {
    throw new AppError("FORBIDDEN", "Not the owner of this agent");
  }
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
    direct: m.direct,
    admin: m.admin,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt?.toISOString() ?? null,
  };
}

export function toPrincipalResponse(p: Principal): PrincipalResponse {
  return {
    id: p.id,
    kind: p.kind,
    name: p.name,
    ownerId: p.ownerId,
    spaceId: p.spaceId,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt?.toISOString() ?? null,
  };
}

export function toGroupResponse(g: Group): GroupResponse {
  return {
    id: g.id,
    name: g.name,
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

export function toApiKeyInfoResponse(k: ApiKeyInfo): ApiKeyInfoResponse {
  return {
    id: k.id,
    memberId: k.memberId,
    lookupId: k.lookupId,
    name: k.name,
    createdAt: k.createdAt.toISOString(),
    expiresAt: k.expiresAt?.toISOString() ?? null,
  };
}

export function toSpaceInvitationResponse(
  i: SpaceInvitation,
): SpaceInvitationResponse {
  return {
    id: i.id,
    email: i.email,
    admin: i.admin,
    shareAccess: i.shareAccess,
    invitedBy: i.invitedBy,
    invitedByName: i.invitedByName,
    createdAt: i.createdAt.toISOString(),
  };
}
