// packages/server/start.ts
//
// Callable server bootstrap. `startServer()` stands up the same stack the
// production entrypoint (index.ts) runs — pools → bootstrap/migrate → router →
// worker pool → Bun.serve — but with **no** process-level side effects
// (no SIGINT/SIGTERM/unhandledRejection handlers, no process.exit, no
// telemetry configure()). It returns a `RunningServer` handle whose `stop()`
// tears everything down. index.ts is the thin entrypoint that wraps this with
// telemetry + signal handling; the e2e harness calls it directly.
import {
  bootstrapSpaceDatabase,
  migrateAuth,
  migrateCore,
  migrateSpace,
  slugToSchema as spaceSlugToSchema,
} from "@memory.build/database";
import { reportError } from "@memory.build/database/telemetry";
import {
  type EmbeddingConfig,
  getTokenizerThreadCount,
  shutdownTokenizerPool,
} from "@memory.build/embedding";
import { type CoreStore, coreStore } from "@memory.build/engine/core";
import { info, span } from "@pydantic/logfire-node";
import postgres, { type Sql } from "postgres";
import { MIN_CLIENT_VERSION, SERVER_VERSION } from "../../version";
import { createBetterAuth } from "./auth/betterauth";
import { cleanupExpiredAuth } from "./auth/cleanup";
import { tokenRequestTelemetryAttributes } from "./auth/oauth-request-metadata";
import type { ServerContext } from "./context";
import { buildEmbeddingConfig, parseIntEnv } from "./embedding-config";
import { checkSizeLimit } from "./middleware";
import {
  httpRequestTelemetryAttributes,
  httpResponseTelemetryAttributes,
  observeHttpRequest,
  setTelemetryAttributes,
  tokenResponseTelemetryAttributes,
} from "./request-telemetry";
import { createRouter } from "./router";
import { internalError } from "./util/response";
import { buildWorkerSettings, resolveWorkerCount } from "./worker-config";
import { type RunningEmbeddingWorkers, startWorkerPool } from "./worker-start";

interface RpcDbTimeoutsMs {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  transactionTimeoutMs: number;
  idleInTransactionSessionTimeoutMs: number;
}

const DEFAULT_RPC_DB_TIMEOUTS_MS: RpcDbTimeoutsMs = {
  statementTimeoutMs: 30_000,
  lockTimeoutMs: 5_000,
  transactionTimeoutMs: 35_000,
  idleInTransactionSessionTimeoutMs: 35_000,
};

export { buildEmbeddingConfig } from "./embedding-config";

export interface StartServerOptions {
  /** Cancel startup and stop new worker claims without abandoning in-flight work. */
  signal?: AbortSignal;
  /** HTTP port. Default PORT env or 3000; 0 = OS-assigned random port. */
  port?: number;
  /** Application pool connection string. Default DATABASE_URL. */
  databaseUrl?: string;
  /** Worker pool connection string. Default WORKER_DATABASE_URL ?? databaseUrl. */
  workerDatabaseUrl?: string;
  /** Public URL for OAuth callbacks. Default API_BASE_URL. */
  apiBaseUrl?: string;
  /** better-auth signing secret. Default BETTER_AUTH_SECRET. */
  betterAuthSecret?: string;
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
  /** Run the expired-auth-rows cleanup cron. Default true; harness sets false. */
  enableCleanupCron?: boolean;
  /** Run bootstrap + migrate on boot. Default true. */
  migrate?: boolean;
  /** Session-level database timeouts for runtime request work, in milliseconds. */
  rpcDbTimeoutsMs?: RpcDbTimeoutsMs;
  /** Directory of the built web UI to serve. Default WEB_DIST ?? "packages/web/dist". */
  webDist?: string;
}

export interface RunningServer {
  /** e.g. http://localhost:<port> */
  url: string;
  port: number;
  context: ServerContext;
  /** Rejects if an embedding loop dies; absent in API-only mode. */
  workerFinished?: Promise<void>;
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
async function remigrateSpaces(
  db: Sql,
  core: CoreStore,
  signal?: AbortSignal,
): Promise<void> {
  const spaces = await core.listSpaces();
  const failed: string[] = [];
  for (const space of spaces) {
    if (signal?.aborted) break;
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
  signal?.throwIfAborted();
  info(`${spaces.length} space schema(s) re-migrated`);
}

/**
 * Boot the server stack and return a handle. No process-level side effects —
 * the caller owns signal handling and process exit (index.ts does this).
 */
export async function startServer(
  opts: StartServerOptions = {},
): Promise<RunningServer> {
  opts.signal?.throwIfAborted();
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

  // Static web UI: the directory to serve, and the origins allowed to make
  // cookie-authenticated requests (CSRF gate). The public origin (derived from
  // API_BASE_URL) is always allowed; WEB_ALLOWED_ORIGINS adds extras (e.g. to
  // permit both api.* and app.* during a cutover).
  const webDist = opts.webDist ?? process.env.WEB_DIST ?? "packages/web/dist";
  const webAllowedOrigins = [
    new URL(apiBaseUrl).origin,
    ...(process.env.WEB_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ];

  const authCleanupCron =
    process.env.AUTH_CLEANUP_CRON ||
    process.env.DEVICE_FLOW_CLEANUP_CRON || // legacy name, still honored
    "*/15 * * * *";

  // Schema names (single DB, postgres.js pool): auth + core control plane.
  const authSchema = opts.authSchema ?? process.env.AUTH_SCHEMA ?? "auth";
  const coreSchema = opts.coreSchema ?? process.env.CORE_SCHEMA ?? "core";

  const workerCount = resolveWorkerCount(opts.workerCount, true);
  const workerSettings =
    workerCount > 0 ? buildWorkerSettings({ ...opts, workerCount }) : undefined;

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

  const rpcDbTimeoutsMs: RpcDbTimeoutsMs = opts.rpcDbTimeoutsMs ?? {
    statementTimeoutMs: parseIntEnv(
      "RPC_DB_STATEMENT_TIMEOUT_MS",
      process.env.RPC_DB_STATEMENT_TIMEOUT_MS || "",
      String(DEFAULT_RPC_DB_TIMEOUTS_MS.statementTimeoutMs),
    ),
    lockTimeoutMs: parseIntEnv(
      "RPC_DB_LOCK_TIMEOUT_MS",
      process.env.RPC_DB_LOCK_TIMEOUT_MS || "",
      String(DEFAULT_RPC_DB_TIMEOUTS_MS.lockTimeoutMs),
    ),
    transactionTimeoutMs: parseIntEnv(
      "RPC_DB_TRANSACTION_TIMEOUT_MS",
      process.env.RPC_DB_TRANSACTION_TIMEOUT_MS || "",
      String(DEFAULT_RPC_DB_TIMEOUTS_MS.transactionTimeoutMs),
    ),
    idleInTransactionSessionTimeoutMs: parseIntEnv(
      "RPC_DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS",
      process.env.RPC_DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS || "",
      String(DEFAULT_RPC_DB_TIMEOUTS_MS.idleInTransactionSessionTimeoutMs),
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
      opts.signal?.throwIfAborted();
      await migrateCore(migrationDb, { schema: coreSchema });
      opts.signal?.throwIfAborted();
      await migrateAuth(migrationDb, { schema: authSchema });
      opts.signal?.throwIfAborted();
      info("Core + auth schemas migrated");
      await remigrateSpaces(migrationDb, migrationCore, opts.signal);
    } finally {
      await migrationDb.end();
    }
  }

  opts.signal?.throwIfAborted();

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
      statement_timeout: rpcDbTimeoutsMs.statementTimeoutMs,
      lock_timeout: rpcDbTimeoutsMs.lockTimeoutMs,
      transaction_timeout: rpcDbTimeoutsMs.transactionTimeoutMs,
      idle_in_transaction_session_timeout:
        rpcDbTimeoutsMs.idleInTransactionSessionTimeoutMs,
    },
  });

  let authPool: ReturnType<typeof createBetterAuth>["pool"] | undefined;
  let workers: RunningEmbeddingWorkers | undefined;
  let cleanupCron: Bun.CronJob | null = null;
  try {
    // Core control-plane store (core schema) on the runtime application pool.
    const core = coreStore(runtimeDb, coreSchema);

    // better-auth instance + its dedicated, schema-pinned pool. better-auth owns
    // the human identity surface (social login, sessions, OAuth tokens); the api-key path
    // stays in `core`. Its pool is separate from the runtime app pool.
    const betterAuthSecret =
      opts.betterAuthSecret ?? process.env.BETTER_AUTH_SECRET;
    if (!betterAuthSecret) {
      throw new Error("BETTER_AUTH_SECRET environment variable is required");
    }
    const {
      auth: betterAuth,
      pool: authDbPool,
      verifyOAuthAccessToken,
      getUserEmailVerified,
    } = createBetterAuth({
      databaseUrl,
      authSchema,
      baseURL: apiBaseUrl,
      secret: betterAuthSecret,
      trustedOrigins: webAllowedOrigins,
      github:
        process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
          ? {
              clientId: process.env.GITHUB_CLIENT_ID,
              clientSecret: process.env.GITHUB_CLIENT_SECRET,
            }
          : undefined,
      google:
        process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
          ? {
              clientId: process.env.GOOGLE_CLIENT_ID,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            }
          : undefined,
    });

    authPool = authDbPool;

    // ---------------------------------------------------------------------------
    // Router
    // ---------------------------------------------------------------------------

    const tokenizerThreads = getTokenizerThreadCount();
    info("Embedding tokenizer configured", { threads: tokenizerThreads });

    const context: ServerContext = {
      db: runtimeDb,
      betterAuth,
      verifyOAuthToken: verifyOAuthAccessToken,
      getUserEmailVerified,
      core,
      authSchema,
      coreSchema,
      embeddingConfig,
      apiBaseUrl,
      webDist,
      webAllowedOrigins,
      serverVersion: SERVER_VERSION,
      minClientVersion: MIN_CLIENT_VERSION,
    };

    const router = createRouter(context);

    // ---------------------------------------------------------------------------
    // Embedding Worker Pool
    // ---------------------------------------------------------------------------

    if (workerSettings) {
      workers = await startWorkerPool(
        opts.workerDatabaseUrl ??
          process.env.WORKER_DATABASE_URL ??
          databaseUrl,
        embeddingConfig,
        async () =>
          (await core.listSpaces()).map((s) => ({
            schema: spaceSlugToSchema(s.slug),
          })),
        workerSettings,
        workerCount,
        opts.signal,
      );
      opts.signal?.throwIfAborted();
      info("Embedding worker pool started", { workers: workerCount });
    }

    opts.signal?.throwIfAborted();

    // ---------------------------------------------------------------------------
    // Cleanup Jobs
    // ---------------------------------------------------------------------------

    // Sweep expired auth rows on a cron schedule (UTC). better-auth + the OAuth
    // provider + the device-authorization plugin own these tables (sessions,
    // verifications, oauth tokens, device codes) but don't purge expired rows on
    // their own, so this reclaims them.
    cleanupCron =
      (opts.enableCleanupCron ?? true)
        ? Bun.cron(authCleanupCron, async () => {
            try {
              const { sessions, verifications, oauthTokens, deviceCodes } =
                await cleanupExpiredAuth(runtimeDb, authSchema);
              if (sessions || verifications || oauthTokens || deviceCodes) {
                info("Cleaned up expired auth rows", {
                  sessions,
                  verifications,
                  oauthTokens,
                  deviceCodes,
                });
              }
            } catch (error) {
              reportError(
                "Failed to clean up expired auth rows",
                error as Error,
              );
            }
          })
        : null;

    // ---------------------------------------------------------------------------
    // Server
    // ---------------------------------------------------------------------------

    const server = Bun.serve({
      port,
      async fetch(request) {
        return observeHttpRequest(request, async () => {
          try {
            return await span("http.request", {
              attributes: httpRequestTelemetryAttributes(request),
              callback: async (activeSpan) => {
                const sizeError = checkSizeLimit(request);
                // Read a bounded clone concurrently; the auth handler always
                // receives the original body and telemetry emits no new spans.
                const tokenMetadata = sizeError
                  ? Promise.resolve({})
                  : tokenRequestTelemetryAttributes(request);
                const response =
                  sizeError ?? (await router.handleRequest(request));
                setTelemetryAttributes(activeSpan, await tokenMetadata);
                setTelemetryAttributes(
                  activeSpan,
                  httpResponseTelemetryAttributes(response),
                );
                setTelemetryAttributes(
                  activeSpan,
                  await tokenResponseTelemetryAttributes(request, response),
                );
                return response;
              },
            });
          } catch {
            // Error already recorded on http.request span by the helper
            return internalError();
          }
        });
      },
    });

    info("Server started", { port: server.port });

    let stopping: Promise<void> | undefined;
    function stop(): Promise<void> {
      stopping ??= drain();
      return stopping;
    }
    async function drain(): Promise<void> {
      info("Shutting down server...");

      const errors: unknown[] = [];
      // Stop accepting connections and await in-flight handlers before draining
      // their worker/tokenizer/database dependencies.
      try {
        await server.stop();
      } catch (error) {
        errors.push(error);
      }

      // Stop embedding workers
      try {
        await workers?.stop();
        info("Embedding worker pool stopped");
      } catch (error) {
        errors.push(error);
        reportError("Error stopping embedding workers", error as Error);
      }

      try {
        await shutdownTokenizerPool();
        info("Embedding tokenizer pool stopped");
      } catch (error) {
        errors.push(error);
        reportError("Error stopping embedding tokenizer pool", error as Error);
      }

      // Stop background jobs and close both pools even if one drain fails.
      try {
        cleanupCron?.stop();
      } catch (error) {
        errors.push(error);
      }
      for (const pool of [runtimeDb, authDbPool]) {
        try {
          await pool.end();
        } catch (error) {
          errors.push(error);
          reportError("Error closing database connections", error as Error);
        }
      }

      info("Shutdown complete");
      if (errors.length)
        throw new AggregateError(errors, "Server drain failed");
    }

    const boundPort = server.port ?? port;
    return {
      url: `http://localhost:${boundPort}`,
      port: boundPort,
      context,
      workerFinished: workers?.finished,
      stop,
    };
  } catch (error) {
    let failure = error;
    cleanupCron?.stop();
    try {
      await workers?.stop();
    } catch (drainError) {
      if (opts.signal?.aborted && failure === opts.signal.reason)
        failure = drainError;
    }
    const cleanup = await Promise.allSettled([
      runtimeDb.end(),
      authPool?.end(),
      shutdownTokenizerPool(),
    ]);
    if (opts.signal?.aborted && failure === opts.signal.reason) {
      const failed = cleanup.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
    throw failure;
  }
}
