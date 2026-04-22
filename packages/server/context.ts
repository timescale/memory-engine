import type { AccountsDB } from "@memory.build/accounts";
import type { EmbeddingConfig } from "@memory.build/embedding";
import type { SQL } from "bun";

/**
 * Server-wide context containing database connections.
 * Passed to createRouter() at startup.
 */
export interface ServerContext {
  /** Accounts database operations */
  accountsDb: AccountsDB;
  /** Accounts database pool (for health checks) */
  accountsSql: SQL;
  /** Engine database pool (EngineDB created per-request based on slug) */
  engineSql: SQL;
  /** Embedding config for semantic search */
  embeddingConfig: EmbeddingConfig;
  /** Base URL for API callbacks (e.g., "https://memory.build") */
  apiBaseUrl: string;
  /** Application version for migration tracking */
  serverVersion: string;
}
