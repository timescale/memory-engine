/**
 * Accounts RPC me methods.
 *
 * Implements:
 * - me.get: Get the current authenticated identity
 */
import type { Identity } from "@memory-engine/accounts";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { type MeGetParams, meGetSchema } from "./schemas";
import { type AccountsRpcContext, assertAccountsRpcContext } from "./types";

// =============================================================================
// Response Types
// =============================================================================

/**
 * Identity response (serializable).
 */
interface IdentityResponse {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  updatedAt: string | null;
}

/**
 * Convert an Identity to a serializable response.
 */
function toIdentityResponse(identity: Identity): IdentityResponse {
  return {
    id: identity.id,
    email: identity.email,
    name: identity.name,
    createdAt: identity.createdAt.toISOString(),
    updatedAt: identity.updatedAt?.toISOString() ?? null,
  };
}

// =============================================================================
// Method Handlers
// =============================================================================

/**
 * me.get - Get the current authenticated identity.
 */
async function meGet(
  _params: MeGetParams,
  context: HandlerContext,
): Promise<IdentityResponse> {
  assertAccountsRpcContext(context);
  const { db, identityId } = context as AccountsRpcContext;

  const identity = await db.getIdentity(identityId);
  if (!identity) {
    throw new AppError("NOT_FOUND", `Identity not found: ${identityId}`);
  }

  return toIdentityResponse(identity);
}

// =============================================================================
// Registry
// =============================================================================

/**
 * Build the me methods registry.
 */
export const meMethods = buildRegistry()
  .register("me.get", meGetSchema, meGet)
  .build();
