/**
 * Transaction helper for accounts operations
 *
 * Simpler than engine's _tx.ts - no RLS roles needed since accounts
 * uses application-level authorization.
 */

import { span } from "@pydantic/logfire-node";
import type { SQL } from "bun";
import type { AccountsContext } from "../types";

const ACCOUNTS_STATEMENT_TIMEOUT =
  process.env.ACCOUNTS_STATEMENT_TIMEOUT ?? "25s";
const ACCOUNTS_LOCK_TIMEOUT = process.env.ACCOUNTS_LOCK_TIMEOUT ?? "5s";
const ACCOUNTS_TRANSACTION_TIMEOUT =
  process.env.ACCOUNTS_TRANSACTION_TIMEOUT ?? "30s";
const ACCOUNTS_IDLE_IN_TRANSACTION_SESSION_TIMEOUT =
  process.env.ACCOUNTS_IDLE_IN_TRANSACTION_SESSION_TIMEOUT ?? "30s";

/**
 * Bound accounts transactions with transaction-local GUCs so pooled
 * connections do not retain settings.
 */
export async function setLocalAccountsTimeouts(sql: SQL): Promise<void> {
  await sql.unsafe("SELECT set_config('statement_timeout', $1, true)", [
    ACCOUNTS_STATEMENT_TIMEOUT,
  ]);
  await sql.unsafe("SELECT set_config('lock_timeout', $1, true)", [
    ACCOUNTS_LOCK_TIMEOUT,
  ]);
  await sql.unsafe("SELECT set_config('transaction_timeout', $1, true)", [
    ACCOUNTS_TRANSACTION_TIMEOUT,
  ]);
  await sql.unsafe(
    "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
    [ACCOUNTS_IDLE_IN_TRANSACTION_SESSION_TIMEOUT],
  );
}

/**
 * Execute a function within a transaction context.
 *
 * If already inside a transaction (ctx.inTransaction is true), runs directly.
 * Otherwise opens a new transaction with search_path set.
 */
export async function withTx<T>(
  ctx: AccountsContext,
  operation: string,
  fn: (sql: SQL) => Promise<T>,
): Promise<T> {
  if (ctx.inTransaction) {
    return fn(ctx.sql);
  }

  return span(`accounts.${operation}`, {
    attributes: {
      "db.schema": ctx.schema,
      "db.operation": operation,
    },
    callback: () =>
      ctx.sql.begin(async (tx) => {
        await setLocalAccountsTimeouts(tx);
        await tx.unsafe(`SET LOCAL search_path TO ${ctx.schema}, public`);
        return fn(tx);
      }),
  });
}

/**
 * Create a derived context for use inside withTransaction()
 */
export function deriveContext(ctx: AccountsContext, tx: SQL): AccountsContext {
  return {
    ...ctx,
    sql: tx,
    inTransaction: true,
  };
}
