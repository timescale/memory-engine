// packages/server/index.ts
import { createAccountsDB } from "@memory-engine/accounts";
import type { EmbeddingConfig } from "@memory-engine/embedding";
import { configure, info, reportError } from "@pydantic/logfire-node";
import { embeddingConstants } from "./config";
import type { ServerContext } from "./context";
import { checkSizeLimit } from "./middleware";
import { createRouter } from "./router";
import { span } from "./telemetry";
import { internalError } from "./util/response";

// Initialize telemetry before starting server
configure({
  sendToLogfire: "if-token-present",
  serviceName: "memory-engine",
  serviceVersion: "0.1.0",
  scrubbing: {
    extraPatterns: [
      "content", // Memory content — potentially sensitive user data
      "embedding", // Vector embeddings — large, not useful in traces
      "access_token",
      "refresh_token",
    ],
  },
});

// =============================================================================
// Environment Variables
// =============================================================================
//
// Required:
//   ACCOUNTS_DATABASE_URL - PostgreSQL connection string for accounts database
//                          (stores engines, API keys, users)
//   ACCOUNTS_MASTER_KEY   - 32-byte hex string for encrypting API keys at rest
//                          Generate with: openssl rand -hex 32
//   ENGINE_DATABASE_URL   - PostgreSQL connection string for engine databases
//                          (stores memories, each engine in its own schema)
//   API_BASE_URL          - Public URL for OAuth callbacks
//                          (e.g., "https://memoryengine.dev")
//
// Optional:
//   PORT            - HTTP server port (default: 3000)
//   ACCOUNTS_SCHEMA - Schema name in accounts database (default: "accounts")
//
// Connection Pool - Accounts Database:
//   ACCOUNTS_POOL_MAX                - Max connections (default: 10)
//   ACCOUNTS_POOL_IDLE_TIMEOUT       - Idle timeout in seconds (default: 30)
//   ACCOUNTS_POOL_MAX_LIFETIME       - Max lifetime in seconds, 0=forever (default: 0)
//   ACCOUNTS_POOL_CONNECTION_TIMEOUT - Connection timeout in seconds (default: 30)
//
// Connection Pool - Engine Database:
//   ENGINE_POOL_MAX                - Max connections (default: 20)
//   ENGINE_POOL_IDLE_TIMEOUT       - Idle timeout in seconds (default: 30)
//   ENGINE_POOL_MAX_LIFETIME       - Max lifetime in seconds, 0=forever (default: 0)
//   ENGINE_POOL_CONNECTION_TIMEOUT - Connection timeout in seconds (default: 30)
//
// Cleanup:
//   DEVICE_FLOW_CLEANUP_INTERVAL_MS - Interval for cleaning up expired device auths
//                                     (default: 900000 = 15 minutes)
//
// =============================================================================

const port = process.env.PORT || 3000;

const accountsDatabaseUrl = process.env.ACCOUNTS_DATABASE_URL;
if (!accountsDatabaseUrl) {
  throw new Error("ACCOUNTS_DATABASE_URL environment variable is required");
}

const accountsMasterKey = process.env.ACCOUNTS_MASTER_KEY;
if (!accountsMasterKey) {
  throw new Error("ACCOUNTS_MASTER_KEY environment variable is required");
}

const engineDatabaseUrl = process.env.ENGINE_DATABASE_URL;
if (!engineDatabaseUrl) {
  throw new Error("ENGINE_DATABASE_URL environment variable is required");
}

const apiBaseUrl = process.env.API_BASE_URL;
if (!apiBaseUrl) {
  throw new Error("API_BASE_URL environment variable is required");
}

// Default: 15 minutes
const deviceFlowCleanupIntervalMs = parseInt(
  process.env.DEVICE_FLOW_CLEANUP_INTERVAL_MS || "900000",
  10,
);

const accountsSchema = process.env.ACCOUNTS_SCHEMA || "accounts";

// Connection pool settings - Accounts database
const accountsPoolMax = parseInt(process.env.ACCOUNTS_POOL_MAX || "10", 10);
const accountsPoolIdleTimeout = parseInt(
  process.env.ACCOUNTS_POOL_IDLE_TIMEOUT || "30",
  10,
);
const accountsPoolMaxLifetime = parseInt(
  process.env.ACCOUNTS_POOL_MAX_LIFETIME || "0",
  10,
);
const accountsPoolConnectionTimeout = parseInt(
  process.env.ACCOUNTS_POOL_CONNECTION_TIMEOUT || "30",
  10,
);

// Connection pool settings - Engine database
const enginePoolMax = parseInt(process.env.ENGINE_POOL_MAX || "20", 10);
const enginePoolIdleTimeout = parseInt(
  process.env.ENGINE_POOL_IDLE_TIMEOUT || "30",
  10,
);
const enginePoolMaxLifetime = parseInt(
  process.env.ENGINE_POOL_MAX_LIFETIME || "0",
  10,
);
const enginePoolConnectionTimeout = parseInt(
  process.env.ENGINE_POOL_CONNECTION_TIMEOUT || "30",
  10,
);

// =============================================================================
// Embedding Config
// =============================================================================
//
// Model and dimensions are hardcoded - all engines use the same embedding model.
// Only the API key is configurable via environment variable.
//
// Required:
//   EMBEDDING_API_KEY     - OpenAI API key
//
// Optional:
//   EMBEDDING_BASE_URL           - API base URL (default: OpenAI)
//   EMBEDDING_TIMEOUT_MS         - Per-call timeout in ms (default: none)
//   EMBEDDING_MAX_RETRIES        - Retries on transient failures (default: 2, from AI SDK)
//   EMBEDDING_MAX_PARALLEL_CALLS - Max concurrent batch chunk requests (default: Infinity)
//
// =============================================================================

function buildEmbeddingConfig(): EmbeddingConfig {
  const apiKey = process.env.EMBEDDING_API_KEY;
  if (!apiKey) {
    throw new Error("EMBEDDING_API_KEY is required");
  }

  const options: EmbeddingConfig["options"] = {};

  if (process.env.EMBEDDING_TIMEOUT_MS) {
    options.timeoutMs = parseInt(process.env.EMBEDDING_TIMEOUT_MS, 10);
  }
  if (process.env.EMBEDDING_MAX_RETRIES) {
    options.maxRetries = parseInt(process.env.EMBEDDING_MAX_RETRIES, 10);
  }
  if (process.env.EMBEDDING_MAX_PARALLEL_CALLS) {
    options.maxParallelCalls = parseInt(
      process.env.EMBEDDING_MAX_PARALLEL_CALLS,
      10,
    );
  }

  return {
    provider: "openai",
    model: embeddingConstants.model,
    dimensions: embeddingConstants.dimensions,
    apiKey,
    baseUrl: process.env.EMBEDDING_BASE_URL,
    options,
  };
}

const embeddingConfig = buildEmbeddingConfig();

// =============================================================================
// Database Pools
// =============================================================================

// Parse master key from hex string to Buffer
const masterKeyBuffer = Buffer.from(accountsMasterKey, "hex");
if (masterKeyBuffer.length !== 32) {
  throw new Error(
    "ACCOUNTS_MASTER_KEY must be a 32-byte (64 character) hex string",
  );
}

// Create database connection pools
const accountsSql = new Bun.SQL(accountsDatabaseUrl, {
  max: accountsPoolMax,
  idleTimeout: accountsPoolIdleTimeout,
  maxLifetime: accountsPoolMaxLifetime,
  connectionTimeout: accountsPoolConnectionTimeout,
});

const engineSql = new Bun.SQL(engineDatabaseUrl, {
  max: enginePoolMax,
  idleTimeout: enginePoolIdleTimeout,
  maxLifetime: enginePoolMaxLifetime,
  connectionTimeout: enginePoolConnectionTimeout,
});

// Create accounts DB with operations layer
const accountsDb = createAccountsDB(accountsSql, accountsSchema, {
  masterKey: masterKeyBuffer,
});

// =============================================================================
// Router
// =============================================================================

const serverContext: ServerContext = {
  accountsDb,
  engineSql,
  embeddingConfig,
  apiBaseUrl,
  appVersion: "0.1.0",
};

const router = createRouter(serverContext);

// =============================================================================
// Cleanup Jobs
// =============================================================================

// Cleanup expired device authorizations periodically
setInterval(async () => {
  try {
    const count = await accountsDb.deleteExpired();
    if (count > 0) {
      info("Cleaned up expired device authorizations", { count });
    }
  } catch (error) {
    reportError("Failed to cleanup device authorizations", error as Error);
  }
}, deviceFlowCleanupIntervalMs);

// =============================================================================
// Server
// =============================================================================

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    try {
      return await span("http.request", {
        attributes: {
          "http.method": method,
          "http.url": request.url,
          "http.path": path,
        },
        callback: async () => {
          // Check size limit
          const sizeError = checkSizeLimit(request);
          if (sizeError) {
            return sizeError;
          }

          // Route and handle request
          return await router.handleRequest(request);
        },
      });
    } catch {
      // Error already recorded on http.request span by the helper
      return internalError();
    }
  },
});

info("Server started", { port });
