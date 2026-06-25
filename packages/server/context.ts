import type { EmbeddingConfig } from "@memory.build/embedding";
import type { CoreStore } from "@memory.build/engine/core";
import type { Sql } from "postgres";
import type {
  Auth,
  GetUserEmailVerified,
  VerifyOAuthAccessToken,
} from "./auth/betterauth";

/**
 * Server-wide context containing database connections.
 * Passed to createRouter() at startup.
 */
export interface ServerContext {
  /** Pool (postgres.js): auth + core + per-space schemas, one DB */
  db: Sql;
  /**
   * better-auth instance (auth schema): GitHub/Google social login, web cookie
   * sessions, and the OAuth 2.1 authorization server. The api-key path stays in
   * `core`.
   */
  betterAuth: Auth;
  /**
   * Resource-server validator for an OAuth access token (the CLI/MCP bearer):
   * hashed lookup → { userId, email, name, scopes } | null.
   */
  verifyOAuthToken: VerifyOAuthAccessToken;
  /**
   * Current `email_verified` for a user id. The api-key (PAT) path uses it to
   * report an honest `emailVerified` (the cookie/OAuth paths get it inline).
   */
  getUserEmailVerified: GetUserEmailVerified;
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
  /** Directory of the built web UI to serve (static assets + SPA fallback). */
  webDist: string;
  /**
   * Origins allowed to make cookie-authenticated requests (the CSRF gate for
   * the browser-login session cookie). Always includes the public origin
   * derived from `apiBaseUrl`.
   */
  webAllowedOrigins: string[];
  /** Application version for migration tracking */
  serverVersion: string;
  /** Oldest CLIENT_VERSION this server will accept. */
  minClientVersion: string;
}
