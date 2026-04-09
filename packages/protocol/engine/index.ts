/**
 * Engine RPC contract — maps method names to params/result schema pairs.
 *
 * Covers all 30 methods on POST /api/v1/engine/rpc (API key auth).
 */
import type { z } from "zod";

// Domain schemas
import {
  apiKeyCreateParams,
  apiKeyCreateResult,
  apiKeyDeleteParams,
  apiKeyDeleteResult,
  apiKeyGetParams,
  apiKeyListParams,
  apiKeyListResult,
  apiKeyResponse,
  apiKeyRevokeParams,
  apiKeyRevokeResult,
} from "./api-key.ts";
import {
  grantCheckParams,
  grantCheckResult,
  grantCreateParams,
  grantCreateResult,
  grantGetParams,
  grantListParams,
  grantListResult,
  grantResponse,
  grantRevokeParams,
  grantRevokeResult,
} from "./grant.ts";
import {
  memoryBatchCreateParams,
  memoryBatchCreateResult,
  memoryCreateParams,
  memoryDeleteParams,
  memoryDeleteResult,
  memoryDeleteTreeParams,
  memoryDeleteTreeResult,
  memoryGetParams,
  memoryMoveParams,
  memoryMoveResult,
  memoryResponse,
  memorySearchParams,
  memorySearchResult,
  memoryTreeParams,
  memoryTreeResult,
  memoryUpdateParams,
} from "./memory.ts";
import {
  roleAddMemberParams,
  roleAddMemberResult,
  roleCreateParams,
  roleListForUserParams,
  roleListForUserResult,
  roleListMembersParams,
  roleListMembersResult,
  roleRemoveMemberParams,
  roleRemoveMemberResult,
  roleResponse,
} from "./role.ts";
import {
  userCreateParams,
  userDeleteParams,
  userDeleteResult,
  userGetByNameParams,
  userGetParams,
  userListParams,
  userListResult,
  userRenameParams,
  userRenameResult,
  userResponse,
} from "./user.ts";

export * from "./api-key.ts";
export * from "./grant.ts";
// Re-export all domain schemas
export * from "./memory.ts";
export * from "./role.ts";
export * from "./user.ts";

// =============================================================================
// RPC Contract
// =============================================================================

/**
 * Define a method with its params schema and result schema.
 */
function method<TParams extends z.ZodType, TResult extends z.ZodType>(
  params: TParams,
  result: TResult,
) {
  return { params, result };
}

/**
 * Engine RPC method contract — all 30 methods.
 *
 * Each entry maps a method name to its params and result Zod schemas.
 * The client library uses this for type inference and optional response validation.
 * The server uses the params schemas for input validation.
 */
export const engineMethods = {
  // Memory (9)
  "memory.create": method(memoryCreateParams, memoryResponse),
  "memory.batchCreate": method(
    memoryBatchCreateParams,
    memoryBatchCreateResult,
  ),
  "memory.get": method(memoryGetParams, memoryResponse),
  "memory.update": method(memoryUpdateParams, memoryResponse),
  "memory.delete": method(memoryDeleteParams, memoryDeleteResult),
  "memory.search": method(memorySearchParams, memorySearchResult),
  "memory.tree": method(memoryTreeParams, memoryTreeResult),
  "memory.move": method(memoryMoveParams, memoryMoveResult),
  "memory.deleteTree": method(memoryDeleteTreeParams, memoryDeleteTreeResult),

  // User (6)
  "user.create": method(userCreateParams, userResponse),
  "user.get": method(userGetParams, userResponse),
  "user.getByName": method(userGetByNameParams, userResponse),
  "user.list": method(userListParams, userListResult),
  "user.rename": method(userRenameParams, userRenameResult),
  "user.delete": method(userDeleteParams, userDeleteResult),

  // Grant (5)
  "grant.create": method(grantCreateParams, grantCreateResult),
  "grant.list": method(grantListParams, grantListResult),
  "grant.get": method(grantGetParams, grantResponse),
  "grant.revoke": method(grantRevokeParams, grantRevokeResult),
  "grant.check": method(grantCheckParams, grantCheckResult),

  // Role (5)
  "role.create": method(roleCreateParams, roleResponse),
  "role.addMember": method(roleAddMemberParams, roleAddMemberResult),
  "role.removeMember": method(roleRemoveMemberParams, roleRemoveMemberResult),
  "role.listMembers": method(roleListMembersParams, roleListMembersResult),
  "role.listForUser": method(roleListForUserParams, roleListForUserResult),

  // API Key (5)
  "apiKey.create": method(apiKeyCreateParams, apiKeyCreateResult),
  "apiKey.get": method(apiKeyGetParams, apiKeyResponse),
  "apiKey.list": method(apiKeyListParams, apiKeyListResult),
  "apiKey.revoke": method(apiKeyRevokeParams, apiKeyRevokeResult),
  "apiKey.delete": method(apiKeyDeleteParams, apiKeyDeleteResult),
} as const;

// =============================================================================
// Type Utilities
// =============================================================================

/** Union of all engine method names. */
export type EngineMethodName = keyof typeof engineMethods;

/** Extract the params type for a given engine method. */
export type EngineParams<M extends EngineMethodName> = z.infer<
  (typeof engineMethods)[M]["params"]
>;

/** Extract the result type for a given engine method. */
export type EngineResult<M extends EngineMethodName> = z.infer<
  (typeof engineMethods)[M]["result"]
>;

/** Get the params schema for runtime validation. */
export function getEngineParamsSchema<M extends EngineMethodName>(method: M) {
  return engineMethods[method].params;
}

/** Get the result schema for runtime response validation. */
export function getEngineResultSchema<M extends EngineMethodName>(method: M) {
  return engineMethods[method].result;
}
