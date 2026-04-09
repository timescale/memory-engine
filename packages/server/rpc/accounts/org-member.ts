/**
 * Accounts RPC org member methods.
 *
 * Implements:
 * - org.member.list: List members of an organization
 * - org.member.add: Add a member to an organization
 * - org.member.remove: Remove a member from an organization
 * - org.member.updateRole: Update a member's role
 */
import { AccountsError, type OrgMember } from "@memory-engine/accounts";
import type {
  OrgMemberAddParams,
  OrgMemberListParams,
  OrgMemberRemoveParams,
  OrgMemberResponse,
  OrgMemberUpdateRoleParams,
} from "@memory-engine/protocol/accounts/org-member";
import {
  orgMemberAddParams,
  orgMemberListParams,
  orgMemberRemoveParams,
  orgMemberUpdateRoleParams,
} from "@memory-engine/protocol/accounts/org-member";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { type AccountsRpcContext, assertAccountsRpcContext } from "./types";

/**
 * Convert an OrgMember to a serializable response.
 */
function toOrgMemberResponse(member: OrgMember): OrgMemberResponse {
  return {
    orgId: member.orgId,
    identityId: member.identityId,
    role: member.role,
    createdAt: member.createdAt.toISOString(),
  };
}

// =============================================================================
// Method Handlers
// =============================================================================

/**
 * org.member.list - List members of an organization.
 * Requires membership in the org.
 */
async function orgMemberList(
  params: OrgMemberListParams,
  context: HandlerContext,
): Promise<{ members: OrgMemberResponse[] }> {
  assertAccountsRpcContext(context);
  const { db, identity } = context as AccountsRpcContext;

  // Check if caller is a member of the org
  const callerMember = await db.getMember(params.orgId, identity.id);
  if (!callerMember) {
    throw new AppError("FORBIDDEN", "Not a member of this organization");
  }

  const members = await db.listMembers(params.orgId);
  return { members: members.map(toOrgMemberResponse) };
}

/**
 * org.member.add - Add a member to an organization.
 * Requires owner or admin role.
 */
async function orgMemberAdd(
  params: OrgMemberAddParams,
  context: HandlerContext,
): Promise<OrgMemberResponse> {
  assertAccountsRpcContext(context);
  const { db, identity } = context as AccountsRpcContext;

  // Check if caller has admin or owner role
  const callerMember = await db.getMember(params.orgId, identity.id);
  if (
    !callerMember ||
    (callerMember.role !== "owner" && callerMember.role !== "admin")
  ) {
    throw new AppError("FORBIDDEN", "Only owners and admins can add members");
  }

  // Only owners can add other owners
  if (params.role === "owner" && callerMember.role !== "owner") {
    throw new AppError("FORBIDDEN", "Only owners can add other owners");
  }

  const member = await db.addMember(
    params.orgId,
    params.identityId,
    params.role,
  );
  return toOrgMemberResponse(member);
}

/**
 * org.member.remove - Remove a member from an organization.
 * Requires owner or admin role (admins cannot remove owners).
 */
async function orgMemberRemove(
  params: OrgMemberRemoveParams,
  context: HandlerContext,
): Promise<{ removed: boolean }> {
  assertAccountsRpcContext(context);
  const { db, identity } = context as AccountsRpcContext;

  // Check if caller has admin or owner role
  const callerMember = await db.getMember(params.orgId, identity.id);
  if (
    !callerMember ||
    (callerMember.role !== "owner" && callerMember.role !== "admin")
  ) {
    throw new AppError(
      "FORBIDDEN",
      "Only owners and admins can remove members",
    );
  }

  // Check target member's role
  const targetMember = await db.getMember(params.orgId, params.identityId);
  if (!targetMember) {
    throw new AppError("NOT_FOUND", "Member not found");
  }

  // Admins cannot remove owners
  if (targetMember.role === "owner" && callerMember.role !== "owner") {
    throw new AppError("FORBIDDEN", "Only owners can remove other owners");
  }

  try {
    const removed = await db.removeMember(params.orgId, params.identityId);
    return { removed };
  } catch (err) {
    if (err instanceof AccountsError && err.code === "ORG_MUST_HAVE_OWNER") {
      throw new AppError(
        "CONFLICT",
        "Cannot remove the last owner from an organization",
      );
    }
    throw err;
  }
}

/**
 * org.member.updateRole - Update a member's role.
 * Requires owner or admin role (admins cannot promote to owner or demote owners).
 */
async function orgMemberUpdateRole(
  params: OrgMemberUpdateRoleParams,
  context: HandlerContext,
): Promise<{ updated: boolean }> {
  assertAccountsRpcContext(context);
  const { db, identity } = context as AccountsRpcContext;

  // Check if caller has admin or owner role
  const callerMember = await db.getMember(params.orgId, identity.id);
  if (
    !callerMember ||
    (callerMember.role !== "owner" && callerMember.role !== "admin")
  ) {
    throw new AppError(
      "FORBIDDEN",
      "Only owners and admins can update member roles",
    );
  }

  // Check target member's current role
  const targetMember = await db.getMember(params.orgId, params.identityId);
  if (!targetMember) {
    throw new AppError("NOT_FOUND", "Member not found");
  }

  // Only owners can:
  // - Promote to owner
  // - Demote from owner
  if (
    (params.role === "owner" || targetMember.role === "owner") &&
    callerMember.role !== "owner"
  ) {
    throw new AppError(
      "FORBIDDEN",
      "Only owners can promote to or demote from owner role",
    );
  }

  try {
    const updated = await db.updateRole(
      params.orgId,
      params.identityId,
      params.role,
    );
    return { updated };
  } catch (err) {
    if (err instanceof AccountsError && err.code === "ORG_MUST_HAVE_OWNER") {
      throw new AppError(
        "CONFLICT",
        "Cannot remove the last owner from an organization",
      );
    }
    throw err;
  }
}

// =============================================================================
// Registry
// =============================================================================

/**
 * Build the org member methods registry.
 */
export const orgMemberMethods = buildRegistry()
  .register("org.member.list", orgMemberListParams, orgMemberList)
  .register("org.member.add", orgMemberAddParams, orgMemberAdd)
  .register("org.member.remove", orgMemberRemoveParams, orgMemberRemove)
  .register(
    "org.member.updateRole",
    orgMemberUpdateRoleParams,
    orgMemberUpdateRole,
  )
  .build();
