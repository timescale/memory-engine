import type { SQL } from "bun";
import type { OpsContext } from "../types";
import { span } from "@pydantic/logfire-node";

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

/**
 * Execute a function within a transaction context.
 *
 * If already inside a transaction (ctx.inTransaction is true), just sets
 * the appropriate role and runs the function on the existing handle.
 *
 * If not inside a transaction, opens a new one with:
 * - SET LOCAL pgdog.shard (if shard is set, for future sharding)
 * - SET LOCAL search_path (insurance — all SQL is schema-qualified)
 * - SET LOCAL ROLE (me_ro for read, me_rw for write)
 * - set_config('me.user_id', ...) (for RLS)
 */
export async function withTx<T>(
  ctx: OpsContext,
  mode: TransactionMode,
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
  return span("db.transaction", {
    attributes: {
      "db.schema": ctx.schema,
      "db.mode": mode,
      "db.role": role ?? "owner",
    },
    callback: () =>
      ctx.sql.begin(async (tx) => {
        // Future: pgDog shard routing
        if (ctx.shard !== undefined) {
          await tx.unsafe(`SET LOCAL pgdog.shard TO ${ctx.shard}`);
        }

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
