/**
 * Accounts RPC context types.
 *
 * Extends the base HandlerContext with accounts-specific fields.
 */
import type { AccountsDB } from "@memory-engine/accounts";
import type { SQL } from "bun";
import type { Identity } from "../../middleware/authenticate";
import type { HandlerContext } from "../types";

/**
 * Accounts handler context (new style).
 *
 * Provides access to:
 * - `identity`: The authenticated identity (human user)
 */
export interface AccountsContext extends HandlerContext {
  /** Authenticated identity */
  identity: Identity;
}

/**
 * Type guard to check if context has accounts fields.
 */
export function isAccountsContext(ctx: HandlerContext): ctx is AccountsContext {
  return (
    "identity" in ctx &&
    typeof ctx.identity === "object" &&
    ctx.identity !== null &&
    "id" in ctx.identity &&
    "email" in ctx.identity
  );
}

/**
 * Assert that context is an AccountsContext, throwing if not.
 */
export function assertAccountsContext(
  ctx: HandlerContext,
): asserts ctx is AccountsContext {
  if (!isAccountsContext(ctx)) {
    throw new Error(
      "Accounts context not initialized (authentication required)",
    );
  }
}

/**
 * Accounts RPC handler context (legacy style).
 *
 * Provides access to:
 * - `db`: AccountsDB instance for accounts operations
 * - `identityId`: The authenticated identity's ID (from OAuth session)
 * - `engineSql`: SQL connection to the engine database (for schema provisioning)
 * - `appVersion`: Application version string (for migration tracking)
 *
 * Authentication middleware populates these fields via OAuth session validation.
 *
 * @deprecated Use AccountsContext instead. This type will be removed once
 * handlers are migrated to use identity directly.
 */
export interface AccountsRpcContext extends HandlerContext {
  /** AccountsDB instance */
  db: AccountsDB;
  /** Authenticated identity ID */
  identityId: string;
  /** SQL connection to the engine database */
  engineSql: SQL;
  /** Application version string */
  appVersion: string;
}

/**
 * Type guard to check if context has legacy accounts fields.
 *
 * @deprecated Use isAccountsContext instead.
 */
export function isAccountsRpcContext(
  ctx: HandlerContext,
): ctx is AccountsRpcContext {
  return (
    "db" in ctx &&
    typeof ctx.db === "object" &&
    ctx.db !== null &&
    "identityId" in ctx &&
    typeof ctx.identityId === "string" &&
    "engineSql" in ctx &&
    typeof ctx.engineSql === "function" &&
    "appVersion" in ctx &&
    typeof ctx.appVersion === "string"
  );
}

/**
 * Assert that context is an AccountsRpcContext, throwing if not.
 *
 * @deprecated Use assertAccountsContext instead.
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
