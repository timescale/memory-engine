import { info, reportError } from "@pydantic/logfire-node";
import type { SQL } from "bun";
import { processBatch } from "./process";
import type { EngineTarget, WorkerConfig, WorkerStats } from "./types";

/**
 * Process one engine's embedding queue. Returns true if work was found.
 */
export async function runOnce(
  sql: SQL,
  target: EngineTarget,
  config: WorkerConfig,
): Promise<boolean> {
  const result = await processBatch(sql, target, config);
  return result.claimed > 0;
}

/**
 * Discover engine schemas and poll their embedding queues in round-robin.
 *
 * Adaptive delay: short delay when busy (queue likely has more), long delay
 * when idle. Exponential backoff on consecutive errors.
 */
export async function runDaemon(
  sql: SQL,
  config: WorkerConfig,
  options?: { signal?: AbortSignal; stats?: WorkerStats },
): Promise<void> {
  const idleDelayMs = config.idleDelayMs ?? 10_000;
  const maxBackoffMs = config.maxBackoffMs ?? 60_000;
  const refreshIntervalMs = config.refreshIntervalMs ?? 60_000;
  const drainTimeoutMs = config.drainTimeoutMs;
  const signal = options?.signal;
  const stats = options?.stats;

  let targets = await config.discover();
  let lastRefresh = Date.now();
  let consecutiveErrors = 0;
  let idleSince: number | null = null;

  try {
    while (!signal?.aborted) {
      // Periodic engine re-discovery
      if (Date.now() - lastRefresh >= refreshIntervalMs) {
        targets = await config.discover();
        lastRefresh = Date.now();
      }

      if (targets.length === 0) {
        if (signal?.aborted) break;
        await sleep(idleDelayMs);
        continue;
      }

      try {
        let anyWork = false;

        for (const target of targets) {
          if (signal?.aborted) break;
          const result = await processBatch(sql, target, config);
          if (result.claimed > 0) anyWork = true;
          if (stats) {
            stats.schemasPolled++;
            stats.totalProcessed += result.succeeded;
            stats.totalFailed += result.failed;
          }
        }

        consecutiveErrors = 0;
        if (stats) {
          stats.consecutiveErrors = 0;
          stats.lastError = undefined;
        }

        if (anyWork) {
          idleSince = null;
        } else if (drainTimeoutMs != null) {
          idleSince ??= Date.now();
          if (Date.now() - idleSince >= drainTimeoutMs) break;
        }

        if (signal?.aborted) break;

        if (!anyWork) await sleep(idleDelayMs);
      } catch (error) {
        consecutiveErrors++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (stats) {
          stats.consecutiveErrors = consecutiveErrors;
          stats.lastError = errorMsg;
        }
        reportError("Worker batch processing failed", error as Error, {
          consecutiveErrors,
          engineCount: targets.length,
        });

        if (signal?.aborted) break;

        const backoffMs = Math.min(
          idleDelayMs * 2 ** (consecutiveErrors - 1),
          maxBackoffMs,
        );
        await sleep(backoffMs);
      }
    }
  } finally {
    info("Embedding worker daemon stopped", {
      consecutiveErrors,
      engineCount: targets.length,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
