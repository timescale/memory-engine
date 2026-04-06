import type { SQL } from "bun";
import { deriveContext } from "./ops/_tx";
import { type ApiKeyOps, apiKeyOps } from "./ops/api-key";
import { type GrantOps, grantOps } from "./ops/grant";
import { type MemoryOps, memoryOps } from "./ops/memory";
import { type OwnerOps, ownerOps } from "./ops/owner";
import { type RoleOps, roleOps } from "./ops/role";
import { type UserOps, userOps } from "./ops/user";
import type { OpsContext } from "./types";

export interface CreateEngineDBOptions {
  /** Shard number for pgDog routing (future use) */
  shard?: number;
}

/**
 * All ops combined
 */
type AllOps = UserOps & ApiKeyOps & GrantOps & OwnerOps & RoleOps & MemoryOps;

/**
 * EngineDB interface - explicit type to avoid circular reference issues
 */
export interface EngineDB extends AllOps {
  setUser(id: string): void;
  getUserId(): string | null;
  getSchema(): string;
  getEngineSlug(): string;
  withTransaction<T>(
    mode: "read" | "write",
    fn: (db: EngineDB) => Promise<T>,
  ): Promise<T>;
}

/**
 * Compose all ops into a single object
 */
function composeOps(ctx: OpsContext, engineSlug: string): AllOps {
  return {
    ...userOps(ctx),
    ...apiKeyOps(ctx, engineSlug),
    ...grantOps(ctx),
    ...ownerOps(ctx),
    ...roleOps(ctx),
    ...memoryOps(ctx),
  };
}

/**
 * Extract engine slug from schema name (e.g., "me_abc123xyz789" -> "abc123xyz789")
 */
function extractSlugFromSchema(schema: string): string {
  if (schema.startsWith("me_")) {
    return schema.slice(3);
  }
  throw new Error(`Invalid schema name: ${schema} (must start with "me_")`);
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
  let userId: string | null = null;
  const engineSlug = extractSlugFromSchema(schema);

  const ctx: OpsContext = {
    sql,
    schema,
    shard: options?.shard,
    inTransaction: false,
    getUserId: () => userId,
  };

  const ops = composeOps(ctx, engineSlug);

  const db: EngineDB = {
    ...ops,

    /**
     * Set the current user ID for RLS context.
     * This should be called after authentication, before making database calls.
     */
    setUser(id: string): void {
      userId = id;
    },

    /**
     * Get the current user ID
     */
    getUserId(): string | null {
      return userId;
    },

    /**
     * Get the schema name for this engine
     */
    getSchema(): string {
      return schema;
    },

    /**
     * Get the engine slug (for API key generation)
     */
    getEngineSlug(): string {
      return engineSlug;
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
        if (userId) {
          await tx`SELECT set_config('me.user_id', ${userId}, true)`;
        }

        // Create a derived context for the transaction
        const txCtx = deriveContext(ctx, tx);
        const txOps = composeOps(txCtx, engineSlug);

        // Create a transactional EngineDB instance
        const txDb: EngineDB = {
          ...txOps,
          setUser(id: string): void {
            userId = id;
          },
          getUserId(): string | null {
            return userId;
          },
          getSchema(): string {
            return schema;
          },
          getEngineSlug(): string {
            return engineSlug;
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
