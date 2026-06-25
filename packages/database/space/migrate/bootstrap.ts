import { info, span } from "@pydantic/logfire-node";
import type { Sql as SQL } from "postgres";
import {
  acquireAdvisoryLock,
  advisoryLockKey,
  applySessionTimeouts,
  ensurePostgresVersion,
  ensureRequiredExtensions,
  REQUIRED_EXTENSIONS,
} from "../../migrate/kit";
import { reportError } from "../../telemetry";

/**
 * Prepare a physical database to host space schemas.
 *
 * This does not create or migrate an individual space. Spaces are still created
 * on demand by migrateSpace(), which provisions a specific me_<slug> schema.
 */
export async function bootstrapSpaceDatabase(
  sql: SQL,
  statementTimeout: string = "20s",
  lockTimeout: string = "5s",
  transactionTimeout: string = "30s",
  idleInTransactionSessionTimeout: string = "30s",
): Promise<void> {
  const attributes = {
    "db.statement_timeout": statementTimeout,
    "db.lock_timeout": lockTimeout,
    "db.transaction_timeout": transactionTimeout,
    "db.idle_in_transaction_session_timeout": idleInTransactionSessionTimeout,
    "space.required_extensions": REQUIRED_EXTENSIONS.map(
      (extension) => `${extension.name}@>=${extension.minVersion}`,
    ),
  };

  await span("space.bootstrap", {
    attributes,
    callback: async () => {
      try {
        const [key1, key2] = advisoryLockKey("memory-space:bootstrap");
        await sql.begin(async (tx) => {
          await ensurePostgresVersion(tx);
          const acquired = await span("space.bootstrap.acquire_lock", {
            callback: () => acquireAdvisoryLock(tx, key1, key2),
          });
          if (!acquired) {
            throw new Error("Failed to acquire advisory lock");
          }
          await applySessionTimeouts(tx, {
            statementTimeout,
            lockTimeout,
            transactionTimeout,
            idleInTransactionSessionTimeout,
          });
          await ensureRequiredExtensions(tx, "space.bootstrap");
        });
        info("Space bootstrap completed", attributes);
      } catch (error) {
        reportError("Space bootstrap failed", error as Error, attributes);
        throw error;
      }
    },
  });
}
