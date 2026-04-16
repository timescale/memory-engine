/**
 * Accounts RPC context types.
 *
 * Extends the base HandlerContext with accounts-specific fields.
 */
import type { AccountsDB } from "@memory.build/accounts";
import type { SQL } from "bun";
import type { Identity } from "../../middleware/authenticate";
import type { HandlerContext } from "../types";

/**
 * Accounts RPC handler context.
 *
 * Provides access to:
 * - `db`: AccountsDB instance for accounts operations
 * - `identity`: The authenticated identity (from OAuth session)
 * - `engineSql`: SQL connection to the engine database (for schema provisioning)
 * - `appVersion`: Application version string (for migration tracking)
 *
 * Authentication middleware populates these fields via OAuth session validation.
 */
export interface AccountsRpcContext extends HandlerContext {
  /** AccountsDB instance */
  db: AccountsDB;
  /** Authenticated identity */
  identity: Identity;
  /** SQL connection to the engine database */
  engineSql: SQL;
  /** Application version string */
  appVersion: string;
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
    "identity" in ctx &&
    typeof ctx.identity === "object" &&
    ctx.identity !== null &&
    "id" in ctx.identity &&
    "email" in ctx.identity &&
    "engineSql" in ctx &&
    typeof ctx.engineSql === "function" &&
    "appVersion" in ctx &&
    typeof ctx.appVersion === "string"
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
