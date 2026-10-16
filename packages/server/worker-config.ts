import {
  DEFAULT_WORKER_TIMEOUTS,
  type WorkerConfig,
} from "@memory.build/worker";
import { parseIntEnv } from "./embedding-config";

export function resolveWorkerCount(count?: number, allowZero = false): number {
  const raw = process.env.WORKER_COUNT || "2";
  const value = count ?? Number(raw);
  if (
    (count === undefined && !raw.trim()) ||
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1)
  ) {
    throw new Error(
      `WORKER_COUNT must be a ${allowZero ? "non-negative" : "positive"} integer`,
    );
  }
  return value;
}

function envInt(name: string, fallback: number): number {
  return parseIntEnv(name, process.env[name] || "", String(fallback));
}

/** Only call when workers are enabled: API-only mode ignores worker settings. */
export function buildWorkerSettings(opts: {
  workerCount: number;
  workerIdleDelayMs?: number;
  workerRefreshIntervalMs?: number;
}) {
  return {
    pool: {
      max: envInt("WORKER_DB_POOL_MAX", opts.workerCount),
      idle_timeout: envInt(
        "WORKER_DB_POOL_IDLE_REAP_SECONDS",
        envInt("DB_POOL_IDLE_REAP_SECONDS", 300),
      ),
      max_lifetime: envInt(
        "WORKER_DB_POOL_MAX_LIFETIME",
        envInt("DB_POOL_MAX_LIFETIME", 0),
      ),
      connect_timeout: envInt(
        "WORKER_DB_POOL_CONNECTION_TIMEOUT",
        envInt("DB_POOL_CONNECTION_TIMEOUT", 30),
      ),
    },
    config: {
      batchSize: envInt("WORKER_BATCH_SIZE", 10),
      lockDuration: process.env.WORKER_LOCK_DURATION || "5 minutes",
      idleDelayMs:
        opts.workerIdleDelayMs ?? envInt("WORKER_IDLE_DELAY_MS", 10_000),
      maxBackoffMs: envInt("WORKER_MAX_BACKOFF_MS", 60_000),
      refreshIntervalMs:
        opts.workerRefreshIntervalMs ??
        envInt("WORKER_REFRESH_INTERVAL_MS", 60_000),
      timeouts: {
        statementTimeout:
          process.env.WORKER_DB_STATEMENT_TIMEOUT ??
          DEFAULT_WORKER_TIMEOUTS.statementTimeout,
        lockTimeout:
          process.env.WORKER_DB_LOCK_TIMEOUT ??
          DEFAULT_WORKER_TIMEOUTS.lockTimeout,
        transactionTimeout:
          process.env.WORKER_DB_TRANSACTION_TIMEOUT ??
          DEFAULT_WORKER_TIMEOUTS.transactionTimeout,
        idleInTransactionSessionTimeout:
          process.env.WORKER_DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT ??
          DEFAULT_WORKER_TIMEOUTS.idleInTransactionSessionTimeout,
      },
    } satisfies Partial<WorkerConfig>,
  };
}
