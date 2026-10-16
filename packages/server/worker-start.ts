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
): Promise<RunningEmbeddingWorkers> {
  const db = postgres(databaseUrl, {
    ...settings.pool,
    onnotice: () => {},
    connection: { application_name: "me-worker" },
  });
  const pool = new WorkerPool(db, { ...settings.config, embedding, discover });
  try {
    await pool.start(count);
  } catch (error) {
    await db.end();
    throw error;
  }
  const finished = pool.finished;
  void finished.catch(() => {});
  let stopping: Promise<void> | undefined;
  return {
    get stats() {
      return pool.stats;
    },
    finished,
    stop() {
      stopping ??= (async () => {
        try {
          await pool.stop();
        } finally {
          await db.end();
        }
      })();
      return stopping;
    },
  };
}

/** No migrations, auth, cron, HTTP server, or process handlers. */
export async function startEmbeddingWorkers(
  opts: StartEmbeddingWorkersOptions = {},
): Promise<RunningEmbeddingWorkers> {
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
    );
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
