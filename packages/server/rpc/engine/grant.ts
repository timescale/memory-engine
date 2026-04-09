/**
 * Engine RPC grant methods.
 *
 * Implements:
 * - grant.create: Grant tree access to a user
 * - grant.list: List grants (optionally filter by user)
 * - grant.get: Get a specific grant
 * - grant.revoke: Revoke tree access
 * - grant.check: Check if user has access to a tree path for an action
 */
import type { TreeGrant } from "@memory-engine/engine";
import type {
  GrantCheckParams,
  GrantCreateParams,
  GrantGetParams,
  GrantListParams,
  GrantResponse,
  GrantRevokeParams,
} from "@memory-engine/protocol/engine/grant";
import {
  grantCheckParams,
  grantCreateParams,
  grantGetParams,
  grantListParams,
  grantRevokeParams,
} from "@memory-engine/protocol/engine/grant";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { assertEngineContext, type EngineContext } from "./types";

/**
 * Convert a TreeGrant to a serializable response.
 */
function toGrantResponse(grant: TreeGrant): GrantResponse {
  return {
    id: grant.id,
    userId: grant.userId,
    treePath: grant.treePath,
    actions: grant.actions,
    grantedBy: grant.grantedBy,
    withGrantOption: grant.withGrantOption,
    createdAt: grant.createdAt.toISOString(),
  };
}

// =============================================================================
// Method Handlers
// =============================================================================

/**
 * grant.create - Grant tree access to a user.
 */
async function grantCreate(
  params: GrantCreateParams,
  context: HandlerContext,
): Promise<{ created: boolean }> {
  assertEngineContext(context);
  const { db, userId } = context as EngineContext;

  await db.grantTreeAccess({
    userId: params.userId,
    treePath: params.treePath,
    actions: params.actions,
    grantedBy: userId,
    withGrantOption: params.withGrantOption,
  });

  return { created: true };
}

/**
 * grant.list - List grants.
 */
async function grantList(
  params: GrantListParams,
  context: HandlerContext,
): Promise<{ grants: GrantResponse[] }> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const grants = await db.listTreeGrants(params.userId);
  return { grants: grants.map(toGrantResponse) };
}

/**
 * grant.get - Get a specific grant.
 */
async function grantGet(
  params: GrantGetParams,
  context: HandlerContext,
): Promise<GrantResponse> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const grant = await db.getTreeGrant(params.userId, params.treePath);
  if (!grant) {
    throw new AppError(
      "NOT_FOUND",
      `Grant not found for user ${params.userId} at path ${params.treePath}`,
    );
  }

  return toGrantResponse(grant);
}

/**
 * grant.revoke - Revoke tree access.
 */
async function grantRevoke(
  params: GrantRevokeParams,
  context: HandlerContext,
): Promise<{ revoked: boolean }> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const revoked = await db.revokeTreeAccess(params.userId, params.treePath);
  if (!revoked) {
    throw new AppError(
      "NOT_FOUND",
      `Grant not found for user ${params.userId} at path ${params.treePath}`,
    );
  }

  return { revoked };
}

/**
 * grant.check - Check if user has access to a tree path for an action.
 */
async function grantCheck(
  params: GrantCheckParams,
  context: HandlerContext,
): Promise<{ allowed: boolean }> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const allowed = await db.checkTreeAccess(
    params.userId,
    params.treePath,
    params.action,
  );

  return { allowed };
}

// =============================================================================
// Registry
// =============================================================================

/**
 * Build the grant methods registry.
 */
export const grantMethods = buildRegistry()
  .register("grant.create", grantCreateParams, grantCreate)
  .register("grant.list", grantListParams, grantList)
  .register("grant.get", grantGetParams, grantGet)
  .register("grant.revoke", grantRevokeParams, grantRevoke)
  .register("grant.check", grantCheckParams, grantCheck)
  .build();
