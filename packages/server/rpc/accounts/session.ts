/**
 * Accounts RPC session methods.
 *
 * Implements:
 * - session.revoke: Revoke the current session (logout)
 */
import type { SessionRevokeParams } from "@memory-engine/protocol/accounts/session";
import { sessionRevokeParams } from "@memory-engine/protocol/accounts/session";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { type AccountsRpcContext, assertAccountsRpcContext } from "./types";

// =============================================================================
// Method Handlers
// =============================================================================

/**
 * session.revoke - Revoke the current session (logout).
 *
 * This deletes all sessions for the authenticated identity,
 * effectively logging the user out of all devices.
 *
 * TODO: If we need per-session revocation, pass sessionId through context.
 */
async function sessionRevoke(
  _params: SessionRevokeParams,
  context: HandlerContext,
): Promise<{ revoked: boolean }> {
  assertAccountsRpcContext(context);
  const { db, identity } = context as AccountsRpcContext;

  const count = await db.deleteSessionsByIdentity(identity.id);
  return { revoked: count > 0 };
}

// =============================================================================
// Registry
// =============================================================================

/**
 * Build the session methods registry.
 */
export const sessionMethods = buildRegistry()
  .register("session.revoke", sessionRevokeParams, sessionRevoke)
  .build();
