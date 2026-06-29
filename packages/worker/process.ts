import { reportError } from "@memory.build/database/telemetry";
import {
  type EmbedResult,
  generateEmbeddings,
  RateLimitError,
} from "@memory.build/embedding";
import { info, span, warning } from "@pydantic/logfire-node";
import type { Sql } from "postgres";
import { rateLimitBackoffMs } from "./backoff";
import {
  DEFAULT_WORKER_TIMEOUTS,
  type ProcessResult,
  type SpaceTarget,
  type WorkerConfig,
  type WorkerTimeouts,
} from "./types";

function workerTimeouts(config?: WorkerConfig): WorkerTimeouts {
  return config?.timeouts ?? DEFAULT_WORKER_TIMEOUTS;
}

function timeoutAttributes(timeouts: WorkerTimeouts) {
  return {
    "db.statement_timeout": timeouts.statementTimeout,
    "db.lock_timeout": timeouts.lockTimeout,
    "db.transaction_timeout": timeouts.transactionTimeout,
    "db.idle_in_transaction_session_timeout":
      timeouts.idleInTransactionSessionTimeout,
  };
}

/**
 * Set transaction-local search_path + timeouts. The new model is not sharded
 * and the space functions are security-invoker, so the worker runs as the pool
 * user with no SET ROLE.
 */
async function prepareTx(
  tx: Sql,
  schema: string,
  timeouts: WorkerTimeouts,
): Promise<void> {
  await tx.unsafe(`SET LOCAL search_path TO ${schema}, public`);
  await tx.unsafe("SELECT set_config('statement_timeout', $1, true)", [
    timeouts.statementTimeout,
  ]);
  await tx.unsafe("SELECT set_config('lock_timeout', $1, true)", [
    timeouts.lockTimeout,
  ]);
  await tx.unsafe("SELECT set_config('transaction_timeout', $1, true)", [
    timeouts.transactionTimeout,
  ]);
  await tx.unsafe(
    "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
    [timeouts.idleInTransactionSessionTimeout],
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Delete terminal-outcome queue rows older than the retention window.
 * Runs in its own transaction; failures don't affect the claim path.
 *
 * Returns the number of rows pruned.
 */
export async function pruneQueue(
  sql: Sql,
  target: SpaceTarget,
  retention: string,
  config?: WorkerConfig,
): Promise<number> {
  const { schema } = target;
  const timeouts = workerTimeouts(config);
  return sql.begin(async (tx) => {
    await prepareTx(tx as unknown as Sql, schema, timeouts);
    const rows = (await tx.unsafe(
      `SELECT ${schema}.prune_embedding_queue($1::interval) AS pruned`,
      [retention],
    )) as { pruned: string | number | null }[];
    return Number(rows[0]?.pruned ?? 0);
  }) as Promise<number>;
}

interface ClaimedRow {
  queue_id: string;
  memory_id: string;
  content_version: number;
  content: string;
}

/**
 * Claim a batch from the embedding queue, generate embeddings, and write back.
 *
 * Claim and write-back are separate transactions — if the worker crashes
 * between them, the visibility timeout expires and rows become claimable again.
 * Rows that exhaust their attempts are finalized to 'failed' by the claim
 * function's sweep, so write-back only records last_error and leaves the
 * outcome NULL on transient failure.
 */
export async function processBatch(
  sql: Sql,
  target: SpaceTarget,
  config: WorkerConfig,
): Promise<ProcessResult> {
  const { schema } = target;
  const batchSize = config.batchSize ?? 10;
  const lockDuration = config.lockDuration ?? "5 minutes";
  const timeouts = workerTimeouts(config);
  const attrs = timeoutAttributes(timeouts);

  // --- Claim ---
  const claimStart = performance.now();
  const claimed = (await sql.begin(async (tx) => {
    await prepareTx(tx as unknown as Sql, schema, timeouts);
    return tx.unsafe(
      `SELECT * FROM ${schema}.claim_embedding_batch($1, $2::interval)`,
      [batchSize, lockDuration],
    );
  })) as ClaimedRow[];
  const claimDurationMs = performance.now() - claimStart;

  if (claimed.length === 0) {
    return { claimed: 0, succeeded: 0, failed: 0 };
  }

  info("Embedding batch claimed", {
    "worker.schema": schema,
    "batch.claimed": claimed.length,
    "batch.requested_size": batchSize,
    "batch.lock_duration": lockDuration,
    "batch.claim_duration_ms": claimDurationMs,
    "batch.memoryIds": claimed.map((r) => r.memory_id),
    "batch.queueIds": claimed.map((r) => r.queue_id),
    ...attrs,
  });

  return span("embedding.batch", {
    attributes: {
      "worker.schema": schema,
      "batch.size": claimed.length,
      "batch.requested_size": batchSize,
      "batch.lock_duration": lockDuration,
      "batch.claim_duration_ms": claimDurationMs,
      "batch.memoryIds": claimed.map((r) => r.memory_id),
      "batch.queueIds": claimed.map((r) => r.queue_id),
      ...attrs,
    },
    callback: async () => {
      // --- Embed ---
      const rows = claimed.map((r) => ({
        id: r.memory_id,
        content: r.content,
      }));

      let embedResults: EmbedResult[];
      try {
        embedResults = await generateEmbeddings(rows, config.embedding);
      } catch (error) {
        if (error instanceof RateLimitError) {
          // Undo the attempt increment from claim — rate limits are transient
          // and should not consume the attempt budget — and defer the row's
          // visibility by the same backoff the worker loop sleeps, so another
          // worker can't re-claim it mid-backoff and re-trigger the 429.
          const backoffMs = rateLimitBackoffMs(error.retryAfterMs);
          await sql.begin(async (tx) => {
            await prepareTx(tx as unknown as Sql, schema, timeouts);
            for (const row of claimed) {
              await tx.unsafe(
                `SELECT ${schema}.release_embedding($1, $2::interval)`,
                [row.queue_id, `${backoffMs} milliseconds`],
              );
            }
          });
        }
        throw error;
      }

      info("Embedding batch generated", {
        "worker.schema": schema,
        "batch.claimed": claimed.length,
        "batch.generated": embedResults.length,
        "batch.embed_successes": embedResults.filter((r) => !r.error).length,
        "batch.embed_errors": embedResults.filter((r) => r.error).length,
      });

      const resultMap = new Map(embedResults.map((r) => [r.id, r]));

      // --- Write-back ---
      let succeeded = 0;
      let failed = 0;

      await span("embedding.write_back", {
        attributes: {
          "worker.schema": schema,
          "batch.size": claimed.length,
          "batch.embed_successes": embedResults.filter((r) => !r.error).length,
          "batch.embed_errors": embedResults.filter((r) => r.error).length,
          ...attrs,
        },
        callback: async () => {
          for (const row of claimed) {
            try {
              await sql.begin(async (tx) => {
                await prepareTx(tx as unknown as Sql, schema, timeouts);

                const result = resultMap.get(row.memory_id);

                if (!result || result.error) {
                  // Embedding failed — record the error, leave outcome NULL so
                  // the row retries; the claim sweep fails it once attempts are
                  // exhausted. (Row may be CASCADE-deleted if the memory was
                  // deleted; 0 rows updated is fine.)
                  const error = result?.error ?? "No embedding result returned";
                  await tx.unsafe(`SELECT ${schema}.fail_embedding($1, $2)`, [
                    row.queue_id,
                    error,
                  ]);
                  failed++;
                  return;
                }

                // Version-guarded write-back: writes the memory iff its version
                // still matches the claim and finalizes the queue row —
                // 'completed', or 'cancelled' if the memory was superseded
                // (content changed → newer version) or deleted between claim
                // and embed.
                const vecLiteral = `[${result.embedding.join(",")}]`;
                await tx.unsafe(
                  `SELECT ${schema}.complete_embedding($1, $2, $3, $4::halfvec)`,
                  [
                    row.queue_id,
                    row.memory_id,
                    row.content_version,
                    vecLiteral,
                  ],
                );
                succeeded++;
              });
            } catch (error) {
              const err = asError(error);
              failed++;
              reportError("Embedding row write-back failed", err, {
                "worker.schema": schema,
                "queue.id": row.queue_id,
                "memory.id": row.memory_id,
                "memory.content_version": row.content_version,
              });

              try {
                await sql.begin(async (tx) => {
                  await prepareTx(tx as unknown as Sql, schema, timeouts);
                  await tx.unsafe(`SELECT ${schema}.fail_embedding($1, $2)`, [
                    row.queue_id,
                    err.message,
                  ]);
                });
              } catch (recordError) {
                warning("Failed to record embedding row write-back error", {
                  "worker.schema": schema,
                  "queue.id": row.queue_id,
                  "memory.id": row.memory_id,
                  error: asError(recordError).message,
                });
              }
            }
          }
        },
      });

      const result = { claimed: claimed.length, succeeded, failed };

      info("Embedding batch completed", {
        "worker.schema": schema,
        "batch.claimed": result.claimed,
        "batch.succeeded": result.succeeded,
        "batch.failed": result.failed,
      });

      return result;
    },
  });
}
