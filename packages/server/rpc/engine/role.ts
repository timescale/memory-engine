/**
 * Engine RPC role methods.
 *
 * Implements:
 * - role.create: Create a role (user with canLogin=false)
 * - role.addMember: Add a member to a role
 * - role.removeMember: Remove a member from a role
 * - role.listMembers: List members of a role
 * - role.listForUser: List roles a user belongs to
 */
import type { RoleInfo, RoleMember, User } from "@memory-engine/engine";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import {
  type RoleAddMemberParams,
  type RoleCreateParams,
  type RoleListForUserParams,
  type RoleListMembersParams,
  type RoleRemoveMemberParams,
  roleAddMemberSchema,
  roleCreateSchema,
  roleListForUserSchema,
  roleListMembersSchema,
  roleRemoveMemberSchema,
} from "./schemas";
import { assertEngineContext, type EngineContext } from "./types";

// =============================================================================
// Response Types
// =============================================================================

/**
 * Role response (a user with canLogin=false).
 */
interface RoleResponse {
  id: string;
  name: string;
  ownedBy: string | null;
  createdAt: string;
  updatedAt: string | null;
}

/**
 * Convert a User (role) to a serializable response.
 */
function toRoleResponse(user: User): RoleResponse {
  return {
    id: user.id,
    name: user.name,
    ownedBy: user.ownedBy,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt?.toISOString() ?? null,
  };
}

/**
 * Role member response.
 */
interface RoleMemberResponse {
  roleId: string;
  memberId: string;
  withAdminOption: boolean;
  createdAt: string;
}

/**
 * Convert a RoleMember to a serializable response.
 */
function toRoleMemberResponse(member: RoleMember): RoleMemberResponse {
  return {
    roleId: member.roleId,
    memberId: member.memberId,
    withAdminOption: member.withAdminOption,
    createdAt: member.createdAt.toISOString(),
  };
}

/**
 * Role info response (for listForUser).
 */
interface RoleInfoResponse {
  id: string;
  name: string;
  withAdminOption: boolean;
}

/**
 * Convert a RoleInfo to a serializable response.
 */
function toRoleInfoResponse(info: RoleInfo): RoleInfoResponse {
  return {
    id: info.id,
    name: info.name,
    withAdminOption: info.withAdminOption,
  };
}

// =============================================================================
// Method Handlers
// =============================================================================

/**
 * role.create - Create a role (user with canLogin=false).
 */
async function roleCreate(
  params: RoleCreateParams,
  context: HandlerContext,
): Promise<RoleResponse> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const role = await db.createRole(params.name, params.ownedBy);
  return toRoleResponse(role);
}

/**
 * role.addMember - Add a member to a role.
 */
async function roleAddMember(
  params: RoleAddMemberParams,
  context: HandlerContext,
): Promise<{ added: boolean }> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  try {
    await db.addRoleMember(
      params.roleId,
      params.memberId,
      params.withAdminOption,
    );
    return { added: true };
  } catch (error) {
    // Check for cycle error
    if (
      error instanceof Error &&
      error.message.includes("would create a cycle")
    ) {
      throw new AppError("VALIDATION_ERROR", error.message);
    }
    throw error;
  }
}

/**
 * role.removeMember - Remove a member from a role.
 */
async function roleRemoveMember(
  params: RoleRemoveMemberParams,
  context: HandlerContext,
): Promise<{ removed: boolean }> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const removed = await db.removeRoleMember(params.roleId, params.memberId);
  if (!removed) {
    throw new AppError(
      "NOT_FOUND",
      `Membership not found for role ${params.roleId} and member ${params.memberId}`,
    );
  }

  return { removed };
}

/**
 * role.listMembers - List members of a role.
 */
async function roleListMembers(
  params: RoleListMembersParams,
  context: HandlerContext,
): Promise<{ members: RoleMemberResponse[] }> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const members = await db.listRoleMembers(params.roleId);
  return { members: members.map(toRoleMemberResponse) };
}

/**
 * role.listForUser - List roles a user belongs to.
 */
async function roleListForUser(
  params: RoleListForUserParams,
  context: HandlerContext,
): Promise<{ roles: RoleInfoResponse[] }> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const roles = await db.listRolesForUser(params.userId);
  return { roles: roles.map(toRoleInfoResponse) };
}

// =============================================================================
// Registry
// =============================================================================

/**
 * Build the role methods registry.
 */
export const roleMethods = buildRegistry()
  .register("role.create", roleCreateSchema, roleCreate)
  .register("role.addMember", roleAddMemberSchema, roleAddMember)
  .register("role.removeMember", roleRemoveMemberSchema, roleRemoveMember)
  .register("role.listMembers", roleListMembersSchema, roleListMembers)
  .register("role.listForUser", roleListForUserSchema, roleListForUser)
  .build();
