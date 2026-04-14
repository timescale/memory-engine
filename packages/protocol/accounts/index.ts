/**
 * Accounts RPC contract — maps method names to params/result schema pairs.
 *
 * Covers all 21 methods on POST /api/v1/accounts/rpc (session token auth).
 */
import type { z } from "zod";

// Domain schemas
import {
  engineCreateParams,
  engineDeleteParams,
  engineDeleteResult,
  engineGetParams,
  engineListParams,
  engineListResult,
  engineResponse,
  engineSetupAccessParams,
  engineSetupAccessResult,
  engineUpdateParams,
} from "./engine.ts";
import {
  identityGetByEmailParams,
  identityGetByEmailResult,
  identityResponse,
  meGetParams,
} from "./identity.ts";
import {
  invitationAcceptParams,
  invitationAcceptResult,
  invitationCreateParams,
  invitationCreateResult,
  invitationListParams,
  invitationListResult,
  invitationRevokeParams,
  invitationRevokeResult,
} from "./invitation.ts";
import {
  orgCreateParams,
  orgDeleteParams,
  orgDeleteResult,
  orgGetParams,
  orgListParams,
  orgListResult,
  orgResponse,
  orgUpdateParams,
} from "./org.ts";
import {
  orgMemberAddParams,
  orgMemberListParams,
  orgMemberListResult,
  orgMemberRemoveParams,
  orgMemberRemoveResult,
  orgMemberResponse,
  orgMemberUpdateRoleParams,
  orgMemberUpdateRoleResult,
} from "./org-member.ts";
import { sessionRevokeParams, sessionRevokeResult } from "./session.ts";

export * from "./engine.ts";
// Re-export all domain schemas
export * from "./identity.ts";
export * from "./invitation.ts";
export * from "./org.ts";
export * from "./org-member.ts";
export * from "./session.ts";

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
 * Accounts RPC method contract — all 21 methods.
 *
 * Each entry maps a method name to its params and result Zod schemas.
 * The client library uses this for type inference and optional response validation.
 * The server uses the params schemas for input validation.
 */
export const accountsMethods = {
  // Identity (2)
  "me.get": method(meGetParams, identityResponse),
  "identity.getByEmail": method(
    identityGetByEmailParams,
    identityGetByEmailResult,
  ),

  // Session (1)
  "session.revoke": method(sessionRevokeParams, sessionRevokeResult),

  // Org (5)
  "org.create": method(orgCreateParams, orgResponse),
  "org.list": method(orgListParams, orgListResult),
  "org.get": method(orgGetParams, orgResponse),
  "org.update": method(orgUpdateParams, orgResponse),
  "org.delete": method(orgDeleteParams, orgDeleteResult),

  // Org Member (4)
  "org.member.list": method(orgMemberListParams, orgMemberListResult),
  "org.member.add": method(orgMemberAddParams, orgMemberResponse),
  "org.member.remove": method(orgMemberRemoveParams, orgMemberRemoveResult),
  "org.member.updateRole": method(
    orgMemberUpdateRoleParams,
    orgMemberUpdateRoleResult,
  ),

  // Engine (6)
  "engine.create": method(engineCreateParams, engineResponse),
  "engine.list": method(engineListParams, engineListResult),
  "engine.get": method(engineGetParams, engineResponse),
  "engine.update": method(engineUpdateParams, engineResponse),
  "engine.delete": method(engineDeleteParams, engineDeleteResult),
  "engine.setupAccess": method(
    engineSetupAccessParams,
    engineSetupAccessResult,
  ),

  // Invitation (4)
  "invitation.create": method(invitationCreateParams, invitationCreateResult),
  "invitation.list": method(invitationListParams, invitationListResult),
  "invitation.revoke": method(invitationRevokeParams, invitationRevokeResult),
  "invitation.accept": method(invitationAcceptParams, invitationAcceptResult),
} as const;

// =============================================================================
// Type Utilities
// =============================================================================

/** Union of all accounts method names. */
export type AccountsMethodName = keyof typeof accountsMethods;

/** Extract the params type for a given accounts method. */
export type AccountsParams<M extends AccountsMethodName> = z.infer<
  (typeof accountsMethods)[M]["params"]
>;

/** Extract the result type for a given accounts method. */
export type AccountsResult<M extends AccountsMethodName> = z.infer<
  (typeof accountsMethods)[M]["result"]
>;

/** Get the params schema for runtime validation. */
export function getAccountsParamsSchema<M extends AccountsMethodName>(
  method: M,
) {
  return accountsMethods[method].params;
}

/** Get the result schema for runtime response validation. */
export function getAccountsResultSchema<M extends AccountsMethodName>(
  method: M,
) {
  return accountsMethods[method].result;
}
