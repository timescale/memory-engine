import type { AccountsDB } from "@memory-engine/accounts";
import type { EmbeddingConfig } from "@memory-engine/embedding";
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
  /** Base URL for API callbacks (e.g., "https://memoryengine.dev") */
  apiBaseUrl: string;
  /** Application version for migration tracking */
  appVersion: string;
}
