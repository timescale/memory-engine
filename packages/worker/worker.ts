import { discoverEngineSchemas } from "@memory-engine/engine/migrate";
import type { SQL } from "bun";
import { processBatch } from "./process";
import type { WorkerConfig } from "./types";

/**
 * Process one schema's embedding queue. Returns true if work was found.
 */
export async function runOnce(
  sql: SQL,
  schema: string,
  config: WorkerConfig,
): Promise<boolean> {
  const result = await processBatch(sql, schema, config);
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
  options?: { signal?: AbortSignal },
): Promise<void> {
  const busyDelayMs = config.busyDelayMs ?? 10;
  const idleDelayMs = config.idleDelayMs ?? 10_000;
  const maxBackoffMs = config.maxBackoffMs ?? 60_000;
  const refreshIntervalMs = config.refreshIntervalMs ?? 60_000;
  const drainTimeoutMs = config.drainTimeoutMs;
  const signal = options?.signal;

  let schemas = await discoverEngineSchemas(sql);
  let lastRefresh = Date.now();
  let consecutiveErrors = 0;
  let idleSince: number | null = null;

  try {
    while (!signal?.aborted) {
      // Periodic schema re-discovery
      if (Date.now() - lastRefresh >= refreshIntervalMs) {
        schemas = await discoverEngineSchemas(sql);
        lastRefresh = Date.now();
      }

      if (schemas.length === 0) {
        if (signal?.aborted) break;
        await sleep(idleDelayMs);
        continue;
      }

      try {
        let anyWork = false;

        for (const schema of schemas) {
          if (signal?.aborted) break;
          const hadWork = await runOnce(sql, schema, config);
          if (hadWork) anyWork = true;
        }

        consecutiveErrors = 0;

        if (anyWork) {
          idleSince = null;
        } else if (drainTimeoutMs != null) {
          idleSince ??= Date.now();
          if (Date.now() - idleSince >= drainTimeoutMs) break;
        }

        if (signal?.aborted) break;

        const delay = anyWork ? busyDelayMs : idleDelayMs;
        if (delay > 0) await sleep(delay);
      } catch (error) {
        consecutiveErrors++;
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `Worker error (failure ${consecutiveErrors}): ${message}`,
        );

        if (signal?.aborted) break;

        const backoffMs = Math.min(
          idleDelayMs * 2 ** (consecutiveErrors - 1),
          maxBackoffMs,
        );
        await sleep(backoffMs);
      }
    }
  } finally {
    console.log("Embedding worker daemon stopped");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
