import type { AccountsDB } from "@memory.build/accounts";
import type { AuthStore } from "@memory.build/auth";
import type { EmbeddingConfig } from "@memory.build/embedding";
import type { CoreStore } from "@memory.build/engine/core";
import type { SQL } from "bun";
import type { Sql } from "postgres";

/**
 * Server-wide context containing database connections.
 * Passed to createRouter() at startup.
 */
export interface ServerContext {
  /** Accounts database operations (legacy: org/engine, until Phase 5) */
  accountsDb: AccountsDB;
  /** Accounts database pool (for health checks) */
  accountsSql: SQL;
  /** Engine database pool (EngineDB created per-request based on slug) */
  engineSql: SQL;
  /** New-model pool (postgres.js): auth + core + per-space schemas, one DB */
  db: Sql;
  /** Auth store (auth schema): me/session/identity/device + OAuth accounts */
  auth: AuthStore;
  /** Core control-plane store (core schema): spaces/principals/grants/api-keys */
  core: CoreStore;
  /** The auth schema name */
  authSchema: string;
  /** The core control-plane schema name */
  coreSchema: string;
  /** Embedding config for semantic search */
  embeddingConfig: EmbeddingConfig;
  /** Base URL for API callbacks (e.g., "https://memory.build") */
  apiBaseUrl: string;
  /** Application version for migration tracking */
  serverVersion: string;
  /** Oldest CLIENT_VERSION this server will accept. */
  minClientVersion: string;
}
