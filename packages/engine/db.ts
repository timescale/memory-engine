import type { SQL } from "bun";
import { deriveContext } from "./ops/_tx";
import { type ApiKeyOps, apiKeyOps } from "./ops/api-key";
import { type GrantOps, grantOps } from "./ops/grant";
import { type MemoryOps, memoryOps } from "./ops/memory";
import { type OwnerOps, ownerOps } from "./ops/owner";
import { type PrincipalOps, principalOps } from "./ops/principal";
import { type RoleOps, roleOps } from "./ops/role";
import type { OpsContext } from "./types";

export interface CreateEngineDBOptions {
  /** Shard number for pgDog routing (future use) */
  shard?: number;
}

/**
 * All ops combined
 */
type AllOps = PrincipalOps &
  ApiKeyOps &
  GrantOps &
  OwnerOps &
  RoleOps &
  MemoryOps;

/**
 * EngineDB interface - explicit type to avoid circular reference issues
 */
export interface EngineDB extends AllOps {
  setPrincipal(id: string): void;
  getPrincipalId(): string | null;
  getSchema(): string;
  withTransaction<T>(
    mode: "read" | "write",
    fn: (db: EngineDB) => Promise<T>,
  ): Promise<T>;
}

/**
 * Compose all ops into a single object
 */
function composeOps(ctx: OpsContext): AllOps {
  return {
    ...principalOps(ctx),
    ...apiKeyOps(ctx),
    ...grantOps(ctx),
    ...ownerOps(ctx),
    ...roleOps(ctx),
    ...memoryOps(ctx),
  };
}

/**
 * Create an EngineDB instance for a specific engine schema.
 *
 * EngineDB is the database abstraction layer for a single memory engine.
 * It encapsulates all database operations and handles transaction management,
 * role-based access control, and RLS context setup.
 *
 * @param sql - Database connection pool
 * @param schema - Engine schema name (e.g., "me_abc123xyz789")
 * @param options - Optional configuration (shard number for future pgDog routing)
 */
export function createEngineDB(
  sql: SQL,
  schema: string,
  options?: CreateEngineDBOptions,
): EngineDB {
  let principalId: string | null = null;

  const ctx: OpsContext = {
    sql,
    schema,
    shard: options?.shard,
    inTransaction: false,
    getPrincipalId: () => principalId,
  };

  const ops = composeOps(ctx);

  const db: EngineDB = {
    ...ops,

    /**
     * Set the current principal ID for RLS context.
     * This should be called after authentication, before making database calls.
     */
    setPrincipal(id: string): void {
      principalId = id;
    },

    /**
     * Get the current principal ID
     */
    getPrincipalId(): string | null {
      return principalId;
    },

    /**
     * Get the schema name for this engine
     */
    getSchema(): string {
      return schema;
    },

    /**
     * Execute multiple operations within a single transaction.
     *
     * Use this for batch operations that need to be atomic.
     * Each operation inside the transaction will use the appropriate role
     * (me_ro for reads, me_rw for writes).
     *
     * @param mode - "read" for read-only transaction, "write" for read-write
     * @param fn - Function receiving a transactional EngineDB instance
     */
    async withTransaction<T>(
      mode: "read" | "write",
      fn: (db: EngineDB) => Promise<T>,
    ): Promise<T> {
      const role = mode === "read" ? "me_ro" : "me_rw";

      return sql.begin(async (tx) => {
        // Set up transaction context
        if (ctx.shard !== undefined) {
          await tx.unsafe(`SET LOCAL pgdog.shard TO ${ctx.shard}`);
        }
        await tx.unsafe(`SET LOCAL search_path TO ${schema}, public`);
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        if (principalId) {
          await tx`SELECT set_config('me.principal_id', ${principalId}, true)`;
        }

        // Create a derived context for the transaction
        const txCtx = deriveContext(ctx, tx);
        const txOps = composeOps(txCtx);

        // Create a transactional EngineDB instance
        const txDb: EngineDB = {
          ...txOps,
          setPrincipal(id: string): void {
            principalId = id;
          },
          getPrincipalId(): string | null {
            return principalId;
          },
          getSchema(): string {
            return schema;
          },
          // Nested withTransaction just runs the function directly
          // (already in a transaction)
          async withTransaction<U>(
            _mode: "read" | "write",
            nestedFn: (db: EngineDB) => Promise<U>,
          ): Promise<U> {
            return nestedFn(txDb);
          },
        };

        return fn(txDb);
      });
    },
  };

  return db;
}
