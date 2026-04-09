/**
 * Transaction helper for accounts operations
 *
 * Simpler than engine's _tx.ts - no RLS roles needed since accounts
 * uses application-level authorization.
 */

import { span } from "@pydantic/logfire-node";
import type { SQL } from "bun";
import type { AccountsContext } from "../types";

/**
 * Execute a function within a transaction context.
 *
 * If already inside a transaction (ctx.inTransaction is true), runs directly.
 * Otherwise opens a new transaction with search_path set.
 */
export async function withTx<T>(
  ctx: AccountsContext,
  fn: (sql: SQL) => Promise<T>,
): Promise<T> {
  if (ctx.inTransaction) {
    return fn(ctx.sql);
  }

  return span("accounts.transaction", {
    attributes: {
      "db.schema": ctx.schema,
    },
    callback: () =>
      ctx.sql.begin(async (tx) => {
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
