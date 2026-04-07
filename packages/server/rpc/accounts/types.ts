/**
 * Accounts RPC context types.
 *
 * Extends the base HandlerContext with accounts-specific fields.
 */
import type { AccountsDB } from "@memory-engine/accounts";
import type { HandlerContext } from "../types";

/**
 * Accounts handler context.
 *
 * Provides access to:
 * - `db`: AccountsDB instance for accounts operations
 * - `identityId`: The authenticated identity's ID (from OAuth session)
 *
 * Authentication middleware populates these fields via OAuth session validation.
 */
export interface AccountsRpcContext extends HandlerContext {
  /** AccountsDB instance */
  db: AccountsDB;
  /** Authenticated identity ID */
  identityId: string;
}

/**
 * Type guard to check if context has accounts fields.
 */
export function isAccountsRpcContext(
  ctx: HandlerContext,
): ctx is AccountsRpcContext {
  return (
    "db" in ctx &&
    typeof ctx.db === "object" &&
    ctx.db !== null &&
    "identityId" in ctx &&
    typeof ctx.identityId === "string"
  );
}

/**
 * Assert that context is an AccountsRpcContext, throwing if not.
 */
export function assertAccountsRpcContext(
  ctx: HandlerContext,
): asserts ctx is AccountsRpcContext {
  if (!isAccountsRpcContext(ctx)) {
    throw new Error(
      "Accounts context not initialized (authentication required)",
    );
  }
}
