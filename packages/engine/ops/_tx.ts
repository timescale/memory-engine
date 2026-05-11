import { span } from "@pydantic/logfire-node";
import type { SQL } from "bun";
import type { OpsContext } from "../types";

/**
 * Transaction modes:
 * - "read": Sets ROLE me_ro (read-only, RLS enforced)
 * - "write": Sets ROLE me_rw (read-write, RLS enforced)
 * - "admin": No role change (runs as connection owner, bypasses RLS)
 *
 * Admin mode is used for auth operations (principal, api_key, grant, etc.)
 * which are not protected by RLS — only the memory table has RLS policies.
 */
type TransactionMode = "read" | "write" | "admin";

const ROLE_MAP = {
  read: "me_ro",
  write: "me_rw",
  admin: null, // No role change
} as const;

export interface EngineTimeouts {
  statementTimeout: string;
  lockTimeout: string;
  transactionTimeout: string;
  idleInTransactionSessionTimeout: string;
}

export const DEFAULT_ENGINE_TIMEOUTS: EngineTimeouts = {
  statementTimeout: process.env.ENGINE_STATEMENT_TIMEOUT ?? "25s",
  lockTimeout: process.env.ENGINE_LOCK_TIMEOUT ?? "5s",
  transactionTimeout: process.env.ENGINE_TRANSACTION_TIMEOUT ?? "30s",
  idleInTransactionSessionTimeout:
    process.env.ENGINE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT ?? "30s",
};

/**
 * Bound engine queries so production failures surface before clients give up.
 * Uses transaction-local GUCs so pooled connections do not retain settings.
 */
export async function setLocalEngineTimeouts(
  sql: SQL,
  timeouts: EngineTimeouts = DEFAULT_ENGINE_TIMEOUTS,
): Promise<void> {
  await sql.unsafe("SELECT set_config('statement_timeout', $1, true)", [
    timeouts.statementTimeout,
  ]);
  await sql.unsafe("SELECT set_config('lock_timeout', $1, true)", [
    timeouts.lockTimeout,
  ]);
  await sql.unsafe("SELECT set_config('transaction_timeout', $1, true)", [
    timeouts.transactionTimeout,
  ]);
  await sql.unsafe(
    "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
    [timeouts.idleInTransactionSessionTimeout],
  );
}

/**
 * Execute a function within a transaction context.
 *
 * If already inside a transaction (ctx.inTransaction is true), just sets
 * the appropriate role and runs the function on the existing handle.
 *
 * If not inside a transaction, opens a new one with:
 * - SET LOCAL pgdog.shard (if shard is set, for future sharding)
 * - SET LOCAL statement_timeout / lock_timeout / transaction timeouts
 * - SET LOCAL search_path (insurance — all SQL is schema-qualified)
 * - SET LOCAL ROLE (me_ro for read, me_rw for write)
 * - set_config('me.user_id', ...) (for RLS)
 */
export async function withTx<T>(
  ctx: OpsContext,
  mode: TransactionMode,
  operation: string,
  fn: (sql: SQL) => Promise<T>,
): Promise<T> {
  const role = ROLE_MAP[mode];

  if (ctx.inTransaction) {
    // Already in a transaction — set role (if not admin) and run directly
    if (role) {
      await ctx.sql.unsafe(`SET LOCAL ROLE ${role}`);
    }
    return fn(ctx.sql);
  }

  // Open new transaction with telemetry span
  return span(`db.${operation}`, {
    attributes: {
      "db.schema": ctx.schema,
      "db.mode": mode,
      "db.role": role ?? "owner",
      "db.operation": operation,
    },
    callback: () =>
      ctx.sql.begin(async (tx) => {
        // Future: pgDog shard routing
        if (ctx.shard !== undefined) {
          await tx.unsafe(`SET LOCAL pgdog.shard TO ${ctx.shard}`);
        }

        await setLocalEngineTimeouts(tx);

        // Set search_path: engine schema first, then public (for extension types like ltree)
        await tx.unsafe(`SET LOCAL search_path TO ${ctx.schema}, public`);

        // Set role for permission control (skip for admin mode)
        if (role) {
          await tx.unsafe(`SET LOCAL ROLE ${role}`);
        }

        // Set user_id for RLS policies (only meaningful for read/write modes)
        const userId = ctx.getUserId();
        if (userId && role) {
          await tx`SELECT set_config('me.user_id', ${userId}, true)`;
        }

        return fn(tx);
      }),
  });
}

/**
 * Helper to create a derived OpsContext for use inside withTransaction()
 */
export function deriveContext(ctx: OpsContext, tx: SQL): OpsContext {
  return {
    ...ctx,
    sql: tx,
    inTransaction: true,
  };
}
