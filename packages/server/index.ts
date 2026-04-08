// packages/server/index.ts
import { createAccountsDB } from "@memory-engine/accounts";
import type { EmbeddingConfig } from "@memory-engine/embedding";
import {
  configure,
  info,
  reportError,
  withSpan,
} from "@memory-engine/telemetry";
import { checkSizeLimit } from "./middleware";
import { createRouter } from "./router";
import { internalError } from "./util/response";

// Initialize telemetry before starting server
await configure();

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
//   DEVICE_FLOW_CLEANUP_INTERVAL_MS - Interval for cleaning up expired device auths
//                          (e.g., "900000" for 15 minutes, default: 900000)
//
// Optional:
//   PORT            - HTTP server port (default: 3000)
//   ACCOUNTS_SCHEMA - Schema name in accounts database (default: "accounts")
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

// =============================================================================
// Embedding Config (Optional)
// =============================================================================
//
// For semantic search:
//   EMBEDDING_API_KEY     - OpenAI API key
//   EMBEDDING_MODEL       - Model identifier (e.g., "text-embedding-3-small")
//   EMBEDDING_DIMENSIONS  - Vector dimensions (e.g., 1536)
//
// Optional:
//   EMBEDDING_BASE_URL    - API base URL (default: OpenAI)
//
// If not configured, semantic search returns an error explaining how to enable it.
//
// =============================================================================

function buildEmbeddingConfig(): EmbeddingConfig | undefined {
  const apiKey = process.env.EMBEDDING_API_KEY;
  const model = process.env.EMBEDDING_MODEL;
  const dimensions = process.env.EMBEDDING_DIMENSIONS;

  // All three required for embedding to be enabled
  if (!apiKey || !model || !dimensions) {
    return undefined;
  }

  const parsedDimensions = parseInt(dimensions, 10);
  if (Number.isNaN(parsedDimensions) || parsedDimensions <= 0) {
    throw new Error("EMBEDDING_DIMENSIONS must be a positive integer");
  }

  return {
    provider: "openai",
    model,
    dimensions: parsedDimensions,
    apiKey,
    baseUrl: process.env.EMBEDDING_BASE_URL,
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

// Create database connections
const accountsSql = new Bun.SQL(accountsDatabaseUrl);
const engineSql = new Bun.SQL(engineDatabaseUrl);

// Create accounts DB with operations layer
const accountsDb = createAccountsDB(accountsSql, accountsSchema, {
  masterKey: masterKeyBuffer,
});

// =============================================================================
// Router
// =============================================================================

const router = createRouter({
  accountsDb,
  engineSql,
  embeddingConfig,
  apiBaseUrl,
});

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

    return withSpan(
      "http.request",
      {
        "http.method": method,
        "http.url": request.url,
        "http.path": path,
      },
      async () => {
        try {
          // Check size limit
          const sizeError = checkSizeLimit(request);
          if (sizeError) {
            return sizeError;
          }

          // Route and handle request
          return await router.handleRequest(request);
        } catch (error) {
          reportError("Request failed", error as Error, {
            "http.method": method,
            "http.path": path,
          });
          return internalError();
        }
      },
    );
  },
});

info("Server started", { port });
