/**
 * Accounts RPC me methods.
 *
 * Implements:
 * - me.get: Get the current authenticated identity
 */
import type { Identity } from "@memory-engine/accounts";
import type {
  IdentityGetByEmailParams,
  IdentityGetByEmailResult,
  IdentityResponse,
  MeGetParams,
} from "@memory-engine/protocol/accounts/identity";
import {
  identityGetByEmailParams,
  meGetParams,
} from "@memory-engine/protocol/accounts/identity";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { assertAccountsRpcContext } from "./types";

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
  // Identity is already available from authentication - no DB lookup needed
  return toIdentityResponse(context.identity);
}

/**
 * identity.getByEmail - Look up an identity by email address.
 */
async function identityGetByEmail(
  params: IdentityGetByEmailParams,
  context: HandlerContext,
): Promise<IdentityGetByEmailResult> {
  assertAccountsRpcContext(context);
  const { db } = context as import("./types").AccountsRpcContext;

  const identity = await db.getIdentityByEmail(params.email);
  return { identity: identity ? toIdentityResponse(identity) : null };
}

// =============================================================================
// Registry
// =============================================================================

/**
 * Build the me/identity methods registry.
 */
export const meMethods = buildRegistry()
  .register("me.get", meGetParams, meGet)
  .register("identity.getByEmail", identityGetByEmailParams, identityGetByEmail)
  .build();
