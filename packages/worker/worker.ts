import { RateLimitError } from "@memory.build/embedding";
import { info, reportError, warning } from "@pydantic/logfire-node";
import type { SQL } from "bun";
import { processBatch, pruneQueue } from "./process";
import type { WorkerConfig, WorkerStats } from "./types";

/** Minimum backoff when rate limited, even if Retry-After is shorter. */
const RATE_LIMIT_FLOOR_MS = 30_000;

/**
 * Abortable sleep. Resolves when the timer fires, OR immediately when the
 * signal is aborted — whichever comes first. Lets the worker loop wake up
 * promptly on shutdown instead of waiting out a full backoff interval.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Fisher-Yates shuffle (in-place). */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Embedding worker. Discovers engines from the accounts DB and polls their
 * embedding queues in round-robin, generating embeddings for new memories.
 *
 * Adaptive delay: loops immediately when work is found, sleeps idleDelayMs
 * when idle. Exponential backoff on consecutive errors.
 */
export class Worker {
  private readonly sql: SQL;
  private readonly config: WorkerConfig;
  private abort: AbortController | null = null;
  private runPromise: Promise<void> | null = null;
  readonly _stats: WorkerStats = {
    schemasPolled: 0,
    totalProcessed: 0,
    totalFailed: 0,
    totalPruned: 0,
    consecutiveErrors: 0,
  };

  constructor(sql: SQL, config: WorkerConfig) {
    this.sql = sql;
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.abort) {
      throw new Error("Worker is already running");
    }

    this.abort = new AbortController();
    this.runPromise = run(
      this.sql,
      this.config,
      this.abort.signal,
      this._stats,
    );
  }

  async stop(): Promise<void> {
    if (!this.abort) return;

    this.abort.abort();
    await this.runPromise;
    this.abort = null;
    this.runPromise = null;
  }

  get stats(): WorkerStats {
    return { ...this._stats };
  }
}

async function run(
  sql: SQL,
  config: WorkerConfig,
  signal: AbortSignal,
  stats: WorkerStats,
): Promise<void> {
  const idleDelayMs = config.idleDelayMs ?? 10_000;
  const maxBackoffMs = config.maxBackoffMs ?? 60_000;
  const refreshIntervalMs = config.refreshIntervalMs ?? 60_000;
  const drainTimeoutMs = config.drainTimeoutMs;
  const pruneRetention = config.pruneRetention ?? "7 days";

  let targets = shuffle(await config.discover());
  let lastRefresh = Date.now();
  let consecutiveErrors = 0;
  let idleSince: number | null = null;

  try {
    while (!signal.aborted) {
      // Periodic engine re-discovery
      if (Date.now() - lastRefresh >= refreshIntervalMs) {
        targets = shuffle(await config.discover());
        lastRefresh = Date.now();
      }

      if (targets.length === 0) {
        if (signal.aborted) break;
        await sleep(idleDelayMs, signal);
        continue;
      }

      try {
        let anyWork = false;

        for (const target of targets) {
          if (signal.aborted) break;
          const result = await processBatch(sql, target, config);
          if (result.claimed > 0) {
            anyWork = true;
          } else {
            // Engine had no work to claim — opportunistic moment to prune
            // terminal queue rows. Best-effort: failures are logged but do
            // not trigger the worker error backoff path.
            try {
              const pruned = await pruneQueue(sql, target, pruneRetention);
              stats.totalPruned += pruned;
            } catch (pruneError) {
              warning("Embedding queue prune failed", {
                "worker.schema": target.schema,
                "worker.shard": target.shard,
                error:
                  pruneError instanceof Error
                    ? pruneError.message
                    : String(pruneError),
              });
            }
          }
          stats.schemasPolled++;
          stats.totalProcessed += result.succeeded;
          stats.totalFailed += result.failed;
        }

        consecutiveErrors = 0;
        stats.consecutiveErrors = 0;
        stats.lastError = undefined;

        if (anyWork) {
          idleSince = null;
          shuffle(targets);
        } else if (drainTimeoutMs != null) {
          idleSince ??= Date.now();
          if (Date.now() - idleSince >= drainTimeoutMs) break;
        }

        if (signal.aborted) break;

        if (!anyWork) await sleep(idleDelayMs, signal);
      } catch (error) {
        // Rate limit — back off without incrementing consecutive errors.
        // processBatch already decremented queue attempts so they aren't wasted.
        if (error instanceof RateLimitError) {
          const backoffMs = Math.max(
            error.retryAfterMs ?? RATE_LIMIT_FLOOR_MS,
            RATE_LIMIT_FLOOR_MS,
          );
          warning("Rate limited by embedding provider, backing off", {
            backoffMs,
            retryAfterMs: error.retryAfterMs,
            engineCount: targets.length,
          });

          if (signal.aborted) break;
          await sleep(backoffMs, signal);
          continue;
        }

        consecutiveErrors++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        stats.consecutiveErrors = consecutiveErrors;
        stats.lastError = errorMsg;
        reportError("Worker batch processing failed", error as Error, {
          consecutiveErrors,
          engineCount: targets.length,
        });

        if (signal.aborted) break;

        const backoffMs = Math.min(
          idleDelayMs * 2 ** (consecutiveErrors - 1),
          maxBackoffMs,
        );
        await sleep(backoffMs, signal);
      }
    }
  } finally {
    info("Embedding worker stopped", {
      consecutiveErrors,
      engineCount: targets.length,
    });
  }
}
