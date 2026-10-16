import { slugToSchema } from "@memory.build/database";
import {
  type EmbeddingConfig,
  shutdownTokenizerPool,
} from "@memory.build/embedding";
import { coreStore } from "@memory.build/engine/core";
import {
  type SpaceTarget,
  WorkerPool,
  type WorkerStats,
} from "@memory.build/worker";
import postgres from "postgres";
import { buildEmbeddingConfig } from "./embedding-config";
import { buildWorkerSettings, resolveWorkerCount } from "./worker-config";

export interface StartEmbeddingWorkersOptions {
  /** Stop new claims on abort; drain existing work before rejecting startup. */
  signal?: AbortSignal;
  databaseUrl?: string;
  workerDatabaseUrl?: string;
  coreSchema?: string;
  embeddingConfig?: EmbeddingConfig;
  workerCount?: number;
  workerIdleDelayMs?: number;
  workerRefreshIntervalMs?: number;
}

export interface RunningEmbeddingWorkers {
  stop(): Promise<void>;
  readonly stats: WorkerStats;
  /** Fatal loop errors reject this promise. Callers must monitor it. */
  readonly finished: Promise<void>;
}

/** Shared queue-pool lifecycle. The caller owns discovery and tokenizers. */
export async function startWorkerPool(
  databaseUrl: string,
  embedding: EmbeddingConfig,
  discover: () => Promise<SpaceTarget[]>,
  settings: ReturnType<typeof buildWorkerSettings>,
  count: number,
  signal?: AbortSignal,
): Promise<RunningEmbeddingWorkers> {
  signal?.throwIfAborted();
  const db = postgres(databaseUrl, {
    ...settings.pool,
    onnotice: () => {},
    connection: { application_name: "me-worker" },
  });
  const pool = new WorkerPool(db, {
    ...settings.config,
    embedding,
    // Assign Worker/WorkerPool startup promises before user discovery can
    // synchronously abort and re-enter stop().
    discover: () =>
      Promise.resolve().then(() => {
        // Cancellation is not a fatal discovery failure inside a running loop.
        if (signal?.aborted) return [];
        return discover();
      }),
  });
  let stopping: Promise<void> | undefined;
  function stop(): Promise<void> {
    if (stopping) return stopping;
    signal?.removeEventListener("abort", onAbort);
    stopping ??= (async () => {
      try {
        await pool.stop();
      } finally {
        await db.end();
      }
    })();
    return stopping;
  }
  function onAbort(): void {
    // stop() aborts every partial worker synchronously, but drains provider/DB
    // work. Observe rejection now; startup or the returned stop still owns it.
    void stop().catch(() => {});
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await pool.start(count);
  } catch (error) {
    try {
      await stop();
    } catch (drainError) {
      if (signal?.aborted && error === signal.reason) throw drainError;
    }
    // A real discovery failure wins even if shutdown overlapped it.
    throw error;
  }
  if (signal?.aborted) {
    await stop();
    throw signal.reason;
  }
  const finished = pool.finished;
  void finished.catch(() => {});
  return {
    get stats() {
      return pool.stats;
    },
    finished,
    stop,
  };
}

/** No migrations, auth, cron, HTTP server, or process handlers. */
export async function startEmbeddingWorkers(
  opts: StartEmbeddingWorkersOptions = {},
): Promise<RunningEmbeddingWorkers> {
  opts.signal?.throwIfAborted();
  const count = resolveWorkerCount(opts.workerCount);
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error("DATABASE_URL environment variable is required");
  const embedding = opts.embeddingConfig ?? buildEmbeddingConfig();
  const settings = buildWorkerSettings({ ...opts, workerCount: count });
  // PostgreSQL accepts duration strings for these GUCs. Use postgres.js's open
  // startup-parameter map; its named timeout properties only type numeric ms.
  const discoveryGucs: Record<string, string> = {
    statement_timeout: settings.config.timeouts.statementTimeout,
    lock_timeout: settings.config.timeouts.lockTimeout,
    transaction_timeout: settings.config.timeouts.transactionTimeout,
    idle_in_transaction_session_timeout:
      settings.config.timeouts.idleInTransactionSessionTimeout,
  };
  const discoveryDb = postgres(databaseUrl, {
    max: 1,
    idle_timeout: settings.pool.idle_timeout,
    max_lifetime: settings.pool.max_lifetime,
    connect_timeout: settings.pool.connect_timeout,
    onnotice: () => {},
    connection: {
      application_name: "me-worker-discovery",
      // Discovery runs outside queue transactions. Bound it independently so
      // a blocked catalog query cannot stall startup or shutdown indefinitely.
      ...discoveryGucs,
    },
  });
  let workers: RunningEmbeddingWorkers;
  try {
    const core = coreStore(
      discoveryDb,
      opts.coreSchema ?? process.env.CORE_SCHEMA ?? "core",
    );
    workers = await startWorkerPool(
      opts.workerDatabaseUrl ?? process.env.WORKER_DATABASE_URL ?? databaseUrl,
      embedding,
      async () =>
        (await core.listSpaces()).map((space) => ({
          schema: slugToSchema(space.slug),
        })),
      settings,
      count,
      opts.signal,
    );
    if (opts.signal?.aborted) {
      await workers.stop();
      throw opts.signal.reason;
    }
  } catch (error) {
    try {
      await discoveryDb.end();
    } finally {
      await shutdownTokenizerPool();
    }
    throw error;
  }
  let stopping: Promise<void> | undefined;
  return {
    get stats() {
      return workers.stats;
    },
    finished: workers.finished,
    stop() {
      stopping ??= (async () => {
        try {
          await workers.stop();
        } finally {
          try {
            await discoveryDb.end();
          } finally {
            await shutdownTokenizerPool();
          }
        }
      })();
      return stopping;
    },
  };
}
