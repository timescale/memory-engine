/**
 * Engine RPC owner methods.
 *
 * Implements:
 * - owner.set: Set tree path owner
 * - owner.get: Get tree path owner
 * - owner.remove: Remove tree path owner
 * - owner.list: List tree owners
 */
import type { TreeOwner } from "@memory-engine/engine";
import type {
  OwnerGetParams,
  OwnerListParams,
  OwnerRemoveParams,
  OwnerResponse,
  OwnerSetParams,
} from "@memory-engine/protocol/engine/owner";
import {
  ownerGetParams,
  ownerListParams,
  ownerRemoveParams,
  ownerSetParams,
} from "@memory-engine/protocol/engine/owner";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { assertEngineContext, type EngineContext } from "./types";

/**
 * Convert a TreeOwner to a serializable response.
 */
function toOwnerResponse(owner: TreeOwner): OwnerResponse {
  return {
    treePath: owner.treePath,
    userId: owner.userId,
    createdBy: owner.createdBy,
    createdAt: owner.createdAt.toISOString(),
  };
}

// =============================================================================
// Method Handlers
// =============================================================================

/**
 * owner.set - Set tree path owner (upserts).
 */
async function ownerSet(
  params: OwnerSetParams,
  context: HandlerContext,
): Promise<{ set: boolean }> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  await db.setTreeOwner(
    params.userId,
    params.treePath,
    db.getUserId() ?? undefined,
  );
  return { set: true };
}

/**
 * owner.get - Get tree path owner.
 */
async function ownerGet(
  params: OwnerGetParams,
  context: HandlerContext,
): Promise<OwnerResponse> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const owner = await db.getTreeOwner(params.treePath);
  if (!owner) {
    throw new AppError("NOT_FOUND", `No owner for path: ${params.treePath}`);
  }

  return toOwnerResponse(owner);
}

/**
 * owner.remove - Remove tree path owner.
 */
async function ownerRemove(
  params: OwnerRemoveParams,
  context: HandlerContext,
): Promise<{ removed: boolean }> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const removed = await db.removeTreeOwner(params.treePath);
  if (!removed) {
    throw new AppError("NOT_FOUND", `No owner for path: ${params.treePath}`);
  }

  return { removed };
}

/**
 * owner.list - List tree owners.
 */
async function ownerList(
  params: OwnerListParams,
  context: HandlerContext,
): Promise<{ owners: OwnerResponse[] }> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const owners = await db.listTreeOwners(params.userId);
  return { owners: owners.map(toOwnerResponse) };
}

// =============================================================================
// Registry
// =============================================================================

/**
 * Build the owner methods registry.
 */
export const ownerMethods = buildRegistry()
  .register("owner.set", ownerSetParams, ownerSet)
  .register("owner.get", ownerGetParams, ownerGet)
  .register("owner.remove", ownerRemoveParams, ownerRemove)
  .register("owner.list", ownerListParams, ownerList)
  .build();
