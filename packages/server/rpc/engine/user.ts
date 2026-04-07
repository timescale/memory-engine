/**
 * Engine RPC user methods.
 *
 * Implements:
 * - user.create: Create a new user
 * - user.get: Get user by ID
 * - user.getByName: Get user by name
 * - user.list: List users (optionally filter by canLogin)
 * - user.rename: Rename a user
 * - user.delete: Delete a user
 */
import type { User } from "@memory-engine/engine";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import {
  type UserCreateParams,
  type UserDeleteParams,
  type UserGetByNameParams,
  type UserGetParams,
  type UserListParams,
  type UserRenameParams,
  userCreateSchema,
  userDeleteSchema,
  userGetByNameSchema,
  userGetSchema,
  userListSchema,
  userRenameSchema,
} from "./schemas";
import { assertEngineContext, type EngineContext } from "./types";

// =============================================================================
// Response Types
// =============================================================================

/**
 * User response (serializable).
 */
interface UserResponse {
  id: string;
  name: string;
  ownedBy: string | null;
  canLogin: boolean;
  superuser: boolean;
  createrole: boolean;
  createdAt: string;
  updatedAt: string | null;
}

/**
 * Convert a User to a serializable response.
 */
function toUserResponse(user: User): UserResponse {
  return {
    id: user.id,
    name: user.name,
    ownedBy: user.ownedBy,
    canLogin: user.canLogin,
    superuser: user.superuser,
    createrole: user.createrole,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt?.toISOString() ?? null,
  };
}

// =============================================================================
// Method Handlers
// =============================================================================

/**
 * user.create - Create a new user.
 */
async function userCreate(
  params: UserCreateParams,
  context: HandlerContext,
): Promise<UserResponse> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const user = await db.createUser({
    id: params.id ?? undefined,
    name: params.name,
    ownedBy: params.ownedBy ?? undefined,
    canLogin: params.canLogin,
    superuser: params.superuser,
    createrole: params.createrole,
  });

  return toUserResponse(user);
}

/**
 * user.get - Get user by ID.
 */
async function userGet(
  params: UserGetParams,
  context: HandlerContext,
): Promise<UserResponse> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const user = await db.getUser(params.id);
  if (!user) {
    throw new AppError("NOT_FOUND", `User not found: ${params.id}`);
  }

  return toUserResponse(user);
}

/**
 * user.getByName - Get user by name.
 */
async function userGetByName(
  params: UserGetByNameParams,
  context: HandlerContext,
): Promise<UserResponse> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const user = await db.getUserByName(params.name);
  if (!user) {
    throw new AppError("NOT_FOUND", `User not found: ${params.name}`);
  }

  return toUserResponse(user);
}

/**
 * user.list - List users.
 */
async function userList(
  params: UserListParams,
  context: HandlerContext,
): Promise<{ users: UserResponse[] }> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const users = await db.listUsers(params.canLogin);
  return { users: users.map(toUserResponse) };
}

/**
 * user.rename - Rename a user.
 */
async function userRename(
  params: UserRenameParams,
  context: HandlerContext,
): Promise<{ renamed: boolean }> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const renamed = await db.renameUser(params.id, params.name);
  if (!renamed) {
    throw new AppError("NOT_FOUND", `User not found: ${params.id}`);
  }

  return { renamed };
}

/**
 * user.delete - Delete a user.
 */
async function userDelete(
  params: UserDeleteParams,
  context: HandlerContext,
): Promise<{ deleted: boolean }> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const deleted = await db.deleteUser(params.id);
  if (!deleted) {
    throw new AppError("NOT_FOUND", `User not found: ${params.id}`);
  }

  return { deleted };
}

// =============================================================================
// Registry
// =============================================================================

/**
 * Build the user methods registry.
 */
export const userMethods = buildRegistry()
  .register("user.create", userCreateSchema, userCreate)
  .register("user.get", userGetSchema, userGet)
  .register("user.getByName", userGetByNameSchema, userGetByName)
  .register("user.list", userListSchema, userList)
  .register("user.rename", userRenameSchema, userRename)
  .register("user.delete", userDeleteSchema, userDelete)
  .build();
