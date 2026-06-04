// packages/server/index.ts
import { authStore } from "@memory.build/auth";
import {
  bootstrapSpaceDatabase,
  migrateAuth,
  migrateCore,
  slugToSchema as spaceSlugToSchema,
} from "@memory.build/database";
import type { EmbeddingConfig } from "@memory.build/embedding";
import { coreStore } from "@memory.build/engine/core";
import {
  DEFAULT_WORKER_TIMEOUTS,
  WorkerPool,
  type WorkerTimeouts,
} from "@memory.build/worker";
import { configure, info, reportError, span } from "@pydantic/logfire-node";
import postgres from "postgres";
import { MIN_CLIENT_VERSION, SERVER_VERSION } from "../../version";
import { embeddingConstants } from "./config";
import type { ServerContext } from "./context";
import { checkSizeLimit } from "./middleware";
import { createRouter } from "./router";
import { internalError } from "./util/response";

// Resolve git revision for Logfire code source linking.
// Locally, use the actual commit hash for precise source-linking.
// In containers (no .git dir), use the version tag for prod or "main" for dev.
const gitRevision = (() => {
  try {
    return Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
  } catch {
    const env = process.env.LOGFIRE_ENVIRONMENT ?? "";
    return env.includes("prod") ? `v${SERVER_VERSION}` : "main";
  }
})();

// Initialize telemetry before starting server
configure({
  sendToLogfire: "if-token-present",
  console: process.env.LOGFIRE_CONSOLE === "true",
  serviceName: "memory-engine",
  serviceVersion: SERVER_VERSION,
  codeSource: {
    repository: "https://github.com/timescale/memory-engine",
    revision: gitRevision,
  },
  scrubbing:
    process.env.LOGFIRE_SCRUBBING === "false"
      ? false
      : {
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
//   ENGINE_DATABASE_URL   - PostgreSQL connection string for the database that
//                          holds the auth + core control plane and every
//                          per-space me_<slug> schema (one DB, one pool)
//   API_BASE_URL          - Public URL for OAuth callbacks
//                          (e.g., "https://memory.build")
//
// Optional:
//   PORT            - HTTP server port (default: 3000)
//   AUTH_SCHEMA     - Auth schema name (default: "auth")
//   CORE_SCHEMA     - Core control-plane schema name (default: "core")
//
// Connection Pool - Database:
//   ENGINE_POOL_MAX                - Max connections (default: 20)
//   ENGINE_POOL_IDLE_REAP_SECONDS  - Close idle pooled connections after N seconds (default: 300)
//   ENGINE_POOL_MAX_LIFETIME       - Max lifetime in seconds, 0=forever (default: 0)
//   ENGINE_POOL_CONNECTION_TIMEOUT - Connection timeout in seconds (default: 30)
//   ENGINE_STATEMENT_TIMEOUT       - Per-engine-query timeout (default: 25s)
//   ENGINE_LOCK_TIMEOUT            - Per-engine-lock wait timeout (default: 5s)
//   ENGINE_TRANSACTION_TIMEOUT     - Per-engine-transaction timeout (default: 30s)
//   ENGINE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT - Idle-in-transaction timeout (default: 30s)
//
// Embedding Worker Engine Database:
//   WORKER_ENGINE_DATABASE_URL             - PostgreSQL connection string for worker engine traffic (default: ENGINE_DATABASE_URL)
//   WORKER_ENGINE_POOL_MAX                 - Max worker engine connections (default: WORKER_COUNT)
//   WORKER_ENGINE_POOL_IDLE_REAP_SECONDS   - Close idle pooled connections after N seconds (default: ENGINE_POOL_IDLE_REAP_SECONDS)
//   WORKER_ENGINE_POOL_MAX_LIFETIME        - Max lifetime in seconds, 0=forever (default: ENGINE_POOL_MAX_LIFETIME)
//   WORKER_ENGINE_POOL_CONNECTION_TIMEOUT  - Connection timeout in seconds (default: ENGINE_POOL_CONNECTION_TIMEOUT)
//   WORKER_ENGINE_STATEMENT_TIMEOUT        - Worker engine query timeout (default: ENGINE_STATEMENT_TIMEOUT)
//   WORKER_ENGINE_LOCK_TIMEOUT             - Worker engine lock wait timeout (default: ENGINE_LOCK_TIMEOUT)
//   WORKER_ENGINE_TRANSACTION_TIMEOUT      - Worker engine transaction timeout (default: ENGINE_TRANSACTION_TIMEOUT)
//   WORKER_ENGINE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT - Worker engine idle-in-transaction timeout (default: ENGINE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT)
//
// Cleanup:
//   DEVICE_FLOW_CLEANUP_CRON - Cron schedule for cleaning up expired device auths
//                              (default: "*/15 * * * *" = every 15 minutes, UTC)
//
// Embedding Worker:
//   WORKER_COUNT              - Number of concurrent embedding workers (default: 2)
//   WORKER_BATCH_SIZE         - Queue entries to claim per batch (default: 10)
//   WORKER_LOCK_DURATION      - PostgreSQL interval for claim lock (default: "5 minutes")
//   WORKER_IDLE_DELAY_MS      - Poll interval when idle in ms (default: 10000)
//   WORKER_MAX_BACKOFF_MS     - Max error backoff in ms (default: 60000)
//   WORKER_REFRESH_INTERVAL_MS - Engine re-discovery interval in ms (default: 60000)
//
// =============================================================================

/**
 * Parse an integer from an environment variable with NaN guard.
 */
function parseIntEnv(
  name: string,
  value: string,
  defaultValue: string,
): number {
  const raw = value || defaultValue;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Invalid value for ${name}: "${raw}" is not a valid integer`,
    );
  }
  return parsed;
}

const port = process.env.PORT || 3000;

const engineDatabaseUrl = process.env.ENGINE_DATABASE_URL;
if (!engineDatabaseUrl) {
  throw new Error("ENGINE_DATABASE_URL environment variable is required");
}

const apiBaseUrl = process.env.API_BASE_URL;
if (!apiBaseUrl) {
  throw new Error("API_BASE_URL environment variable is required");
}

const deviceFlowCleanupCron =
  process.env.DEVICE_FLOW_CLEANUP_CRON || "*/15 * * * *";

// Schema names (single DB, postgres.js pool): auth + core control plane.
const authSchema = process.env.AUTH_SCHEMA || "auth";
const coreSchema = process.env.CORE_SCHEMA || "core";

const workerCount = parseIntEnv(
  "WORKER_COUNT",
  process.env.WORKER_COUNT || "",
  "2",
);

// Connection pool settings - database
const enginePoolMax = parseIntEnv(
  "ENGINE_POOL_MAX",
  process.env.ENGINE_POOL_MAX || "",
  "20",
);
const enginePoolIdleReapSeconds = parseIntEnv(
  "ENGINE_POOL_IDLE_REAP_SECONDS",
  process.env.ENGINE_POOL_IDLE_REAP_SECONDS || "",
  "300",
);
const enginePoolMaxLifetime = parseIntEnv(
  "ENGINE_POOL_MAX_LIFETIME",
  process.env.ENGINE_POOL_MAX_LIFETIME || "",
  "0",
);
const enginePoolConnectionTimeout = parseIntEnv(
  "ENGINE_POOL_CONNECTION_TIMEOUT",
  process.env.ENGINE_POOL_CONNECTION_TIMEOUT || "",
  "30",
);

// Connection pool settings - Embedding worker engine database
const workerEngineDatabaseUrl =
  process.env.WORKER_ENGINE_DATABASE_URL || engineDatabaseUrl;
const workerEnginePoolMax = parseIntEnv(
  "WORKER_ENGINE_POOL_MAX",
  process.env.WORKER_ENGINE_POOL_MAX || "",
  String(Math.max(workerCount, 1)),
);
const workerEnginePoolIdleReapSeconds = parseIntEnv(
  "WORKER_ENGINE_POOL_IDLE_REAP_SECONDS",
  process.env.WORKER_ENGINE_POOL_IDLE_REAP_SECONDS || "",
  String(enginePoolIdleReapSeconds),
);
const workerEnginePoolMaxLifetime = parseIntEnv(
  "WORKER_ENGINE_POOL_MAX_LIFETIME",
  process.env.WORKER_ENGINE_POOL_MAX_LIFETIME || "",
  String(enginePoolMaxLifetime),
);
const workerEnginePoolConnectionTimeout = parseIntEnv(
  "WORKER_ENGINE_POOL_CONNECTION_TIMEOUT",
  process.env.WORKER_ENGINE_POOL_CONNECTION_TIMEOUT || "",
  String(enginePoolConnectionTimeout),
);
const workerTimeouts: WorkerTimeouts = {
  statementTimeout:
    process.env.WORKER_ENGINE_STATEMENT_TIMEOUT ??
    DEFAULT_WORKER_TIMEOUTS.statementTimeout,
  lockTimeout:
    process.env.WORKER_ENGINE_LOCK_TIMEOUT ??
    DEFAULT_WORKER_TIMEOUTS.lockTimeout,
  transactionTimeout:
    process.env.WORKER_ENGINE_TRANSACTION_TIMEOUT ??
    DEFAULT_WORKER_TIMEOUTS.transactionTimeout,
  idleInTransactionSessionTimeout:
    process.env.WORKER_ENGINE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT ??
    DEFAULT_WORKER_TIMEOUTS.idleInTransactionSessionTimeout,
};

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
    options.timeoutMs = parseIntEnv(
      "EMBEDDING_TIMEOUT_MS",
      process.env.EMBEDDING_TIMEOUT_MS,
      "0",
    );
  }
  if (process.env.EMBEDDING_MAX_RETRIES) {
    options.maxRetries = parseIntEnv(
      "EMBEDDING_MAX_RETRIES",
      process.env.EMBEDDING_MAX_RETRIES,
      "0",
    );
  }
  if (process.env.EMBEDDING_MAX_PARALLEL_CALLS) {
    options.maxParallelCalls = parseIntEnv(
      "EMBEDDING_MAX_PARALLEL_CALLS",
      process.env.EMBEDDING_MAX_PARALLEL_CALLS,
      "0",
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
// OAuth Provider Validation
// =============================================================================

// Warn at startup if OAuth providers are not configured, rather than
// failing with a confusing error when someone tries to log in.
const configuredProviders: string[] = [];
if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  configuredProviders.push("github");
}
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  configuredProviders.push("google");
}
if (configuredProviders.length === 0) {
  console.warn(
    "WARNING: No OAuth providers configured. Set GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET or GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.",
  );
} else {
  info("OAuth providers configured", { providers: configuredProviders });
}

// =============================================================================
// Database Pools
// =============================================================================

// Dedicated worker pool (postgres.js) — the embedding worker processes the
// per-space me_<slug> schemas.
const workerDb = postgres(workerEngineDatabaseUrl, {
  max: workerEnginePoolMax,
  idle_timeout: workerEnginePoolIdleReapSeconds,
  max_lifetime: workerEnginePoolMaxLifetime,
  connect_timeout: workerEnginePoolConnectionTimeout,
  onnotice: () => {},
});

// The single application pool (postgres.js): the auth + core control plane and
// the per-space me_<slug> data schemas all live in one database, one pool.
const db = postgres(engineDatabaseUrl, {
  max: enginePoolMax,
  idle_timeout: enginePoolIdleReapSeconds,
  max_lifetime: enginePoolMaxLifetime,
  connect_timeout: enginePoolConnectionTimeout,
  onnotice: () => {},
});

// Auth store (auth schema) on the application pool.
const auth = authStore(db, authSchema);

// Core control-plane store (core schema) on the same pool.
const core = coreStore(db, coreSchema);

// =============================================================================
// Database Bootstrap & Migrations (blocking — server won't serve until current)
// =============================================================================

// Prepare the database for per-space schemas (extensions + roles, idempotent)
// and migrate the auth + core control-plane schemas on the application pool.
// If the DB user lacks CREATE EXTENSION privileges (e.g., RDS), bootstrap
// throws with a clear error describing what's missing.
await bootstrapSpaceDatabase(db);
await migrateCore(db);
await migrateAuth(db);
info("Core + auth schemas migrated");

// =============================================================================
// Router
// =============================================================================

const serverContext: ServerContext = {
  db,
  auth,
  core,
  authSchema,
  coreSchema,
  embeddingConfig,
  apiBaseUrl,
  serverVersion: SERVER_VERSION,
  minClientVersion: MIN_CLIENT_VERSION,
};

const router = createRouter(serverContext);

// =============================================================================
// Embedding Worker Pool
// =============================================================================

const workerPool = new WorkerPool(workerDb, {
  embedding: embeddingConfig,
  discover: async () => {
    const spaces = await core.listSpaces();
    return spaces.map((s) => ({ schema: spaceSlugToSchema(s.slug) }));
  },
  batchSize: parseIntEnv(
    "WORKER_BATCH_SIZE",
    process.env.WORKER_BATCH_SIZE || "",
    "10",
  ),
  lockDuration: process.env.WORKER_LOCK_DURATION || "5 minutes",
  idleDelayMs: parseIntEnv(
    "WORKER_IDLE_DELAY_MS",
    process.env.WORKER_IDLE_DELAY_MS || "",
    "10000",
  ),
  maxBackoffMs: parseIntEnv(
    "WORKER_MAX_BACKOFF_MS",
    process.env.WORKER_MAX_BACKOFF_MS || "",
    "60000",
  ),
  refreshIntervalMs: parseIntEnv(
    "WORKER_REFRESH_INTERVAL_MS",
    process.env.WORKER_REFRESH_INTERVAL_MS || "",
    "60000",
  ),
  timeouts: workerTimeouts,
});

await workerPool.start(workerCount);
info("Embedding worker pool started", { workers: workerCount });

// =============================================================================
// Cleanup Jobs
// =============================================================================

// Sweep expired device authorizations and sessions on a cron schedule (UTC).
// Both live in the auth schema now; terminal device states delete themselves on
// poll, so this only reclaims rows that were abandoned before completing.
const cleanupCron = Bun.cron(deviceFlowCleanupCron, async () => {
  try {
    const devices = await auth.deleteExpiredDevices();
    if (devices > 0) {
      info("Cleaned up expired device authorizations", { count: devices });
    }
  } catch (error) {
    reportError("Failed to cleanup device authorizations", error as Error);
  }
  try {
    const sessions = await auth.cleanupExpiredSessions();
    if (sessions > 0) {
      info("Cleaned up expired sessions", { count: sessions });
    }
  } catch (error) {
    reportError("Failed to cleanup expired sessions", error as Error);
  }
});

// =============================================================================
// Server
// =============================================================================

const server = Bun.serve({
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

// =============================================================================
// Graceful Shutdown
// =============================================================================

let shutdownRequested = false;

async function shutdown() {
  if (shutdownRequested) return;
  shutdownRequested = true;

  info("Shutting down server...");

  // Stop accepting new connections
  server.stop();

  // Stop embedding workers
  try {
    await workerPool.stop();
    info("Embedding worker pool stopped");
  } catch (error) {
    reportError("Error stopping embedding workers", error as Error);
  }

  // Stop background jobs
  cleanupCron.stop();

  // Close database pools
  try {
    await workerDb.end();
    await db.end();
  } catch (error) {
    reportError("Error closing database connections", error as Error);
  }

  info("Shutdown complete");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// =============================================================================
// Process Error Handlers
// =============================================================================

process.on("unhandledRejection", (reason) => {
  reportError("Unhandled promise rejection", reason as Error);
});

process.on("uncaughtException", (error) => {
  reportError("Uncaught exception", error);
  process.exit(1);
});
