// packages/server/start.ts
//
// Callable server bootstrap. `startServer()` stands up the same stack the
// production entrypoint (index.ts) runs — pools → bootstrap/migrate → router →
// worker pool → Bun.serve — but with **no** process-level side effects
// (no SIGINT/SIGTERM/unhandledRejection handlers, no process.exit, no
// telemetry configure()). It returns a `RunningServer` handle whose `stop()`
// tears everything down. index.ts is the thin entrypoint that wraps this with
// telemetry + signal handling; the e2e harness calls it directly.
import { authStore } from "@memory.build/auth";
import {
  bootstrapSpaceDatabase,
  migrateAuth,
  migrateCore,
  migrateSpace,
  slugToSchema as spaceSlugToSchema,
} from "@memory.build/database";
import type { EmbeddingConfig } from "@memory.build/embedding";
import { type CoreStore, coreStore } from "@memory.build/engine/core";
import {
  DEFAULT_WORKER_TIMEOUTS,
  WorkerPool,
  type WorkerTimeouts,
} from "@memory.build/worker";
import { info, reportError, span } from "@pydantic/logfire-node";
import postgres, { type Sql } from "postgres";
import { MIN_CLIENT_VERSION, SERVER_VERSION } from "../../version";
import { embeddingConstants } from "./config";
import type { ServerContext } from "./context";
import { checkSizeLimit } from "./middleware";
import { createRouter } from "./router";
import { internalError } from "./util/response";

interface RpcDbTimeouts {
  statementTimeout: number;
  lockTimeout: number;
  transactionTimeout: number;
  idleInTransactionSessionTimeout: number;
}

const DEFAULT_RPC_DB_TIMEOUTS: RpcDbTimeouts = {
  statementTimeout: 30_000,
  lockTimeout: 5_000,
  transactionTimeout: 35_000,
  idleInTransactionSessionTimeout: 35_000,
};

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

/**
 * Build the embedding config from environment variables. Requires
 * EMBEDDING_API_KEY (the server won't boot without it). Used as the default
 * when `StartServerOptions.embeddingConfig` is not supplied.
 */
export function buildEmbeddingConfig(): EmbeddingConfig {
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

export interface StartServerOptions {
  /** HTTP port. Default PORT env or 3000; 0 = OS-assigned random port. */
  port?: number;
  /** Application pool connection string. Default DATABASE_URL. */
  databaseUrl?: string;
  /** Worker pool connection string. Default WORKER_DATABASE_URL ?? databaseUrl. */
  workerDatabaseUrl?: string;
  /** Public URL for OAuth callbacks. Default API_BASE_URL. */
  apiBaseUrl?: string;
  /** Auth schema name. Default AUTH_SCHEMA ?? "auth". */
  authSchema?: string;
  /** Core control-plane schema name. Default CORE_SCHEMA ?? "core". */
  coreSchema?: string;
  /** Embedding config. Default buildEmbeddingConfig() (reads env). */
  embeddingConfig?: EmbeddingConfig;
  /** Number of concurrent embedding workers. Default WORKER_COUNT ?? 2. */
  workerCount?: number;
  /** Worker idle poll interval in ms. Default WORKER_IDLE_DELAY_MS ?? 10000. */
  workerIdleDelayMs?: number;
  /** Worker space-rediscovery interval in ms. Default WORKER_REFRESH_INTERVAL_MS ?? 60000. */
  workerRefreshIntervalMs?: number;
  /** Run the device-flow/session cleanup cron. Default true; harness sets false. */
  enableCleanupCron?: boolean;
  /** Run bootstrap + migrate on boot. Default true. */
  migrate?: boolean;
  /** Session-level database timeouts for runtime request work, in milliseconds. */
  rpcDbTimeouts?: RpcDbTimeouts;
}

export interface RunningServer {
  /** e.g. http://localhost:<port> */
  url: string;
  port: number;
  context: ServerContext;
  /** Tear down: workerPool.stop → cron.stop → server.stop → pools.end. */
  stop(): Promise<void>;
}

/**
 * Re-migrate every existing space schema at boot.
 *
 * Spaces are otherwise migrated only once, at provision time — so a deploy
 * that changes the idempotent space SQL (the function bodies in
 * space/migrate/idempotent/*.sql) would never reach existing spaces without
 * this sweep. Re-running is cheap: incremental migrations are version-tracked
 * no-ops, idempotent files are re-applied (create or replace). Options mirror
 * provisionSpace (all defaults), and migrateSpace's per-schema advisory lock
 * serializes concurrent replica boots.
 *
 * Every space is attempted (so one broken space doesn't hide the rest from
 * the logs), then any failure aborts boot — the server must not serve spaces
 * whose schema may be stale.
 */
async function remigrateSpaces(db: Sql, core: CoreStore): Promise<void> {
  const spaces = await core.listSpaces();
  const failed: string[] = [];
  for (const space of spaces) {
    try {
      await migrateSpace(db, { slug: space.slug });
    } catch (error) {
      failed.push(space.slug);
      reportError(
        `Space ${space.slug} re-migration failed`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `space re-migration failed for ${failed.length} of ${spaces.length} space(s): ${failed.join(", ")}`,
    );
  }
  info(`${spaces.length} space schema(s) re-migrated`);
}

/**
 * Boot the server stack and return a handle. No process-level side effects —
 * the caller owns signal handling and process exit (index.ts does this).
 */
export async function startServer(
  opts: StartServerOptions = {},
): Promise<RunningServer> {
  const port =
    opts.port ?? (process.env.PORT ? Number(process.env.PORT) : 3000);

  // TEMPORARY: fall back to the legacy ENGINE_DATABASE_URL so the multiplayer
  // branch can deploy to dev before the tiger-agents-deploy helm values are
  // migrated to the single-DB env contract. Remove once the deploy config sets
  // DATABASE_URL directly.
  const databaseUrl =
    opts.databaseUrl ??
    process.env.DATABASE_URL ??
    process.env.ENGINE_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL (or legacy ENGINE_DATABASE_URL) environment variable is required",
    );
  }

  const apiBaseUrl = opts.apiBaseUrl ?? process.env.API_BASE_URL;
  if (!apiBaseUrl) {
    throw new Error("API_BASE_URL environment variable is required");
  }

  const deviceFlowCleanupCron =
    process.env.DEVICE_FLOW_CLEANUP_CRON || "*/15 * * * *";

  // Schema names (single DB, postgres.js pool): auth + core control plane.
  const authSchema = opts.authSchema ?? process.env.AUTH_SCHEMA ?? "auth";
  const coreSchema = opts.coreSchema ?? process.env.CORE_SCHEMA ?? "core";

  const workerCount =
    opts.workerCount ??
    parseIntEnv("WORKER_COUNT", process.env.WORKER_COUNT || "", "2");

  // Connection pool settings - database
  const dbPoolMax = parseIntEnv(
    "DB_POOL_MAX",
    process.env.DB_POOL_MAX || "",
    "20",
  );
  const dbPoolIdleReapSeconds = parseIntEnv(
    "DB_POOL_IDLE_REAP_SECONDS",
    process.env.DB_POOL_IDLE_REAP_SECONDS || "",
    "300",
  );
  const dbPoolMaxLifetime = parseIntEnv(
    "DB_POOL_MAX_LIFETIME",
    process.env.DB_POOL_MAX_LIFETIME || "",
    "0",
  );
  const dbPoolConnectionTimeout = parseIntEnv(
    "DB_POOL_CONNECTION_TIMEOUT",
    process.env.DB_POOL_CONNECTION_TIMEOUT || "",
    "30",
  );

  // Connection pool settings - embedding worker database
  const workerDatabaseUrl =
    opts.workerDatabaseUrl ?? process.env.WORKER_DATABASE_URL ?? databaseUrl;
  const workerDbPoolMax = parseIntEnv(
    "WORKER_DB_POOL_MAX",
    process.env.WORKER_DB_POOL_MAX || "",
    String(Math.max(workerCount, 1)),
  );
  const workerDbPoolIdleReapSeconds = parseIntEnv(
    "WORKER_DB_POOL_IDLE_REAP_SECONDS",
    process.env.WORKER_DB_POOL_IDLE_REAP_SECONDS || "",
    String(dbPoolIdleReapSeconds),
  );
  const workerDbPoolMaxLifetime = parseIntEnv(
    "WORKER_DB_POOL_MAX_LIFETIME",
    process.env.WORKER_DB_POOL_MAX_LIFETIME || "",
    String(dbPoolMaxLifetime),
  );
  const workerDbPoolConnectionTimeout = parseIntEnv(
    "WORKER_DB_POOL_CONNECTION_TIMEOUT",
    process.env.WORKER_DB_POOL_CONNECTION_TIMEOUT || "",
    String(dbPoolConnectionTimeout),
  );
  const workerTimeouts: WorkerTimeouts = {
    statementTimeout:
      process.env.WORKER_DB_STATEMENT_TIMEOUT ??
      DEFAULT_WORKER_TIMEOUTS.statementTimeout,
    lockTimeout:
      process.env.WORKER_DB_LOCK_TIMEOUT ?? DEFAULT_WORKER_TIMEOUTS.lockTimeout,
    transactionTimeout:
      process.env.WORKER_DB_TRANSACTION_TIMEOUT ??
      DEFAULT_WORKER_TIMEOUTS.transactionTimeout,
    idleInTransactionSessionTimeout:
      process.env.WORKER_DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT ??
      DEFAULT_WORKER_TIMEOUTS.idleInTransactionSessionTimeout,
  };
  const rpcDbTimeouts: RpcDbTimeouts = opts.rpcDbTimeouts ?? {
    statementTimeout: parseIntEnv(
      "RPC_DB_STATEMENT_TIMEOUT",
      process.env.RPC_DB_STATEMENT_TIMEOUT || "",
      String(DEFAULT_RPC_DB_TIMEOUTS.statementTimeout),
    ),
    lockTimeout: parseIntEnv(
      "RPC_DB_LOCK_TIMEOUT",
      process.env.RPC_DB_LOCK_TIMEOUT || "",
      String(DEFAULT_RPC_DB_TIMEOUTS.lockTimeout),
    ),
    transactionTimeout: parseIntEnv(
      "RPC_DB_TRANSACTION_TIMEOUT",
      process.env.RPC_DB_TRANSACTION_TIMEOUT || "",
      String(DEFAULT_RPC_DB_TIMEOUTS.transactionTimeout),
    ),
    idleInTransactionSessionTimeout: parseIntEnv(
      "RPC_DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT",
      process.env.RPC_DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT || "",
      String(DEFAULT_RPC_DB_TIMEOUTS.idleInTransactionSessionTimeout),
    ),
  };

  const embeddingConfig = opts.embeddingConfig ?? buildEmbeddingConfig();

  // OAuth provider validation: warn at startup if none configured, rather than
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

  // ---------------------------------------------------------------------------
  // Database Bootstrap & Migrations (blocking — server won't serve until current)
  // ---------------------------------------------------------------------------

  // Prepare the database for per-space schemas (extensions + roles, idempotent)
  // and migrate the auth + core control-plane schemas on the migration pool.
  // Pass the configured schemas to BOTH the migrations and the stores so an
  // isolated (non-default) schema is migrated where the stores read it.
  if (opts.migrate ?? true) {
    // Startup migration pool. It is closed once migrations finish so any backend
    // state/memory profile from migration work is not reused by request serving.
    const migrationDb = postgres(databaseUrl, {
      max: dbPoolMax,
      idle_timeout: dbPoolIdleReapSeconds,
      max_lifetime: dbPoolMaxLifetime,
      connect_timeout: dbPoolConnectionTimeout,
      onnotice: () => {},
      connection: { application_name: "me-migration" },
    });
    try {
      const migrationCore = coreStore(migrationDb, coreSchema);
      await bootstrapSpaceDatabase(migrationDb);
      await migrateCore(migrationDb, { schema: coreSchema });
      await migrateAuth(migrationDb, { schema: authSchema });
      info("Core + auth schemas migrated");
      await remigrateSpaces(migrationDb, migrationCore);
    } finally {
      await migrationDb.end();
    }
  }

  // Runtime application pool. Session-level timeout GUCs protect request-path
  // database work without assuming auth/core/space share a transaction.
  const runtimeDb = postgres(databaseUrl, {
    max: dbPoolMax,
    idle_timeout: dbPoolIdleReapSeconds,
    max_lifetime: dbPoolMaxLifetime,
    connect_timeout: dbPoolConnectionTimeout,
    onnotice: () => {},
    connection: {
      application_name: "me-api",
      statement_timeout: rpcDbTimeouts.statementTimeout,
      lock_timeout: rpcDbTimeouts.lockTimeout,
      transaction_timeout: rpcDbTimeouts.transactionTimeout,
      idle_in_transaction_session_timeout:
        rpcDbTimeouts.idleInTransactionSessionTimeout,
    },
  });

  // Auth store (auth schema) on the runtime application pool.
  const auth = authStore(runtimeDb, authSchema);

  // Core control-plane store (core schema) on the runtime application pool.
  const core = coreStore(runtimeDb, coreSchema);

  // ---------------------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------------------

  const context: ServerContext = {
    db: runtimeDb,
    auth,
    core,
    authSchema,
    coreSchema,
    embeddingConfig,
    apiBaseUrl,
    serverVersion: SERVER_VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
  };

  const router = createRouter(context);

  // ---------------------------------------------------------------------------
  // Embedding Worker Pool
  // ---------------------------------------------------------------------------

  // Dedicated worker pool (postgres.js) — the embedding worker processes the
  // per-space me_<slug> schemas.
  const workerDb = postgres(workerDatabaseUrl, {
    max: workerDbPoolMax,
    idle_timeout: workerDbPoolIdleReapSeconds,
    max_lifetime: workerDbPoolMaxLifetime,
    connect_timeout: workerDbPoolConnectionTimeout,
    onnotice: () => {},
    connection: { application_name: "me-worker" },
  });

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
    idleDelayMs:
      opts.workerIdleDelayMs ??
      parseIntEnv(
        "WORKER_IDLE_DELAY_MS",
        process.env.WORKER_IDLE_DELAY_MS || "",
        "10000",
      ),
    maxBackoffMs: parseIntEnv(
      "WORKER_MAX_BACKOFF_MS",
      process.env.WORKER_MAX_BACKOFF_MS || "",
      "60000",
    ),
    refreshIntervalMs:
      opts.workerRefreshIntervalMs ??
      parseIntEnv(
        "WORKER_REFRESH_INTERVAL_MS",
        process.env.WORKER_REFRESH_INTERVAL_MS || "",
        "60000",
      ),
    timeouts: workerTimeouts,
  });

  await workerPool.start(workerCount);
  info("Embedding worker pool started", { workers: workerCount });

  // ---------------------------------------------------------------------------
  // Cleanup Jobs
  // ---------------------------------------------------------------------------

  // Sweep expired device authorizations and sessions on a cron schedule (UTC).
  // Both live in the auth schema now; terminal device states delete themselves
  // on poll, so this only reclaims rows abandoned before completing.
  const cleanupCron =
    (opts.enableCleanupCron ?? true)
      ? Bun.cron(deviceFlowCleanupCron, async () => {
          try {
            const devices = await auth.deleteExpiredDevices();
            if (devices > 0) {
              info("Cleaned up expired device authorizations", {
                count: devices,
              });
            }
          } catch (error) {
            reportError(
              "Failed to cleanup device authorizations",
              error as Error,
            );
          }
          try {
            const sessions = await auth.cleanupExpiredSessions();
            if (sessions > 0) {
              info("Cleaned up expired sessions", { count: sessions });
            }
          } catch (error) {
            reportError("Failed to cleanup expired sessions", error as Error);
          }
        })
      : null;

  // ---------------------------------------------------------------------------
  // Server
  // ---------------------------------------------------------------------------

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
            const sizeError = checkSizeLimit(request);
            if (sizeError) {
              return sizeError;
            }
            return await router.handleRequest(request);
          },
        });
      } catch {
        // Error already recorded on http.request span by the helper
        return internalError();
      }
    },
  });

  info("Server started", { port: server.port });

  let stopped = false;
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;

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
    cleanupCron?.stop();

    // Close database pools
    try {
      await workerDb.end();
      await runtimeDb.end();
    } catch (error) {
      reportError("Error closing database connections", error as Error);
    }

    info("Shutdown complete");
  }

  const boundPort = server.port ?? port;
  return {
    url: `http://localhost:${boundPort}`,
    port: boundPort,
    context,
    stop,
  };
}
