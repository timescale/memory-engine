import {
  type EmbedResult,
  generateEmbeddings,
  RateLimitError,
} from "@memory.build/embedding";
import {
  DEFAULT_ENGINE_TIMEOUTS,
  type EngineTimeouts,
  setLocalEngineTimeouts,
} from "@memory.build/engine/ops/_tx";
import { info, span } from "@pydantic/logfire-node";
import type { SQL } from "bun";
import type { EngineTarget, ProcessResult, WorkerConfig } from "./types";

const WORKER_ENGINE_TIMEOUTS: EngineTimeouts = {
  statementTimeout:
    process.env.WORKER_ENGINE_STATEMENT_TIMEOUT ??
    DEFAULT_ENGINE_TIMEOUTS.statementTimeout,
  lockTimeout:
    process.env.WORKER_ENGINE_LOCK_TIMEOUT ??
    DEFAULT_ENGINE_TIMEOUTS.lockTimeout,
  transactionTimeout:
    process.env.WORKER_ENGINE_TRANSACTION_TIMEOUT ??
    DEFAULT_ENGINE_TIMEOUTS.transactionTimeout,
  idleInTransactionSessionTimeout:
    process.env.WORKER_ENGINE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT ??
    DEFAULT_ENGINE_TIMEOUTS.idleInTransactionSessionTimeout,
};

/**
 * Delete terminal-outcome queue rows older than the retention window.
 * Runs in its own transaction; failures don't affect the claim path.
 *
 * Returns the number of rows pruned.
 */
export async function pruneQueue(
  sql: SQL,
  target: EngineTarget,
  retention: string,
): Promise<number> {
  const { schema, shard } = target;
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL pgdog.shard TO ${shard}`);
    await setLocalEngineTimeouts(tx, WORKER_ENGINE_TIMEOUTS);
    await tx.unsafe(`SET LOCAL search_path TO ${schema}, public`);
    await tx.unsafe("SET LOCAL ROLE me_embed");
    const rows = (await tx.unsafe(
      `SELECT ${schema}.prune_embedding_queue($1::interval) AS pruned`,
      [retention],
    )) as { pruned: string | number | null }[];
    return Number(rows[0]?.pruned ?? 0);
  });
}

interface ClaimedRow {
  queue_id: string;
  memory_id: string;
  embedding_version: number;
  content: string;
}

/**
 * Claim a batch from the embedding queue, generate embeddings, and write back.
 *
 * Claim and write-back are separate transactions — if the worker crashes
 * between them, the visibility timeout expires and rows become claimable again.
 */
export async function processBatch(
  sql: SQL,
  target: EngineTarget,
  config: WorkerConfig,
): Promise<ProcessResult> {
  const { schema, shard } = target;
  const batchSize = config.batchSize ?? 10;
  const lockDuration = config.lockDuration ?? "5 minutes";

  // --- Claim ---
  const claimed = await span("embedding.claim_batch", {
    attributes: {
      "worker.schema": schema,
      "worker.shard": shard,
      "batch.requested_size": batchSize,
      "batch.lock_duration": lockDuration,
    },
    callback: async () => {
      const rows = await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL pgdog.shard TO ${shard}`);
        await setLocalEngineTimeouts(tx, WORKER_ENGINE_TIMEOUTS);
        await tx.unsafe(`SET LOCAL search_path TO ${schema}, public`);
        await tx.unsafe("SET LOCAL ROLE me_embed");
        return tx.unsafe(
          `SELECT * FROM ${schema}.claim_embedding_batch($1, $2::interval)`,
          [batchSize, lockDuration],
        ) as Promise<ClaimedRow[]>;
      });

      if (rows.length > 0) {
        info("Embedding batch claimed", {
          "worker.schema": schema,
          "worker.shard": shard,
          "batch.claimed": rows.length,
          "batch.memoryIds": rows.map((r) => r.memory_id),
          "batch.queueIds": rows.map((r) => r.queue_id),
        });
      }

      return rows;
    },
  });

  if (claimed.length === 0) {
    return { claimed: 0, succeeded: 0, failed: 0 };
  }

  // Process claimed items with telemetry
  return span("embedding.batch", {
    attributes: {
      "worker.schema": schema,
      "worker.shard": shard,
      "batch.size": claimed.length,
      "batch.memoryIds": claimed.map((r) => r.memory_id),
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
          // and should not consume max_attempts
          await sql.begin(async (tx) => {
            await tx.unsafe(`SET LOCAL pgdog.shard TO ${shard}`);
            await setLocalEngineTimeouts(tx, WORKER_ENGINE_TIMEOUTS);
            await tx.unsafe(`SET LOCAL search_path TO ${schema}, public`);
            await tx.unsafe("SET LOCAL ROLE me_embed");
            for (const row of claimed) {
              await tx.unsafe(
                `UPDATE ${schema}.embedding_queue
                 SET attempts = greatest(attempts - 1, 0)
                 WHERE id = $1 AND outcome IS NULL`,
                [row.queue_id],
              );
            }
          });
        }
        throw error;
      }

      info("Embedding batch generated", {
        "worker.schema": schema,
        "worker.shard": shard,
        "batch.claimed": claimed.length,
        "batch.generated": embedResults.length,
        "batch.embed_successes": embedResults.filter((r) => !r.error).length,
        "batch.embed_errors": embedResults.filter((r) => r.error).length,
      });

      // Build lookup: memory_id → embed result
      const resultMap = new Map(embedResults.map((r) => [r.id, r]));

      // --- Write-back ---
      let succeeded = 0;
      let failed = 0;

      await span("embedding.write_back", {
        attributes: {
          "worker.schema": schema,
          "worker.shard": shard,
          "batch.size": claimed.length,
          "batch.embed_successes": embedResults.filter((r) => !r.error).length,
          "batch.embed_errors": embedResults.filter((r) => r.error).length,
        },
        callback: async () => {
          await sql.begin(async (tx) => {
            await tx.unsafe(`SET LOCAL pgdog.shard TO ${shard}`);
            await setLocalEngineTimeouts(tx, WORKER_ENGINE_TIMEOUTS);
            await tx.unsafe(`SET LOCAL search_path TO ${schema}, public`);
            await tx.unsafe("SET LOCAL ROLE me_embed");

            for (const row of claimed) {
              await span("embedding.write_back_row", {
                attributes: {
                  "worker.schema": schema,
                  "worker.shard": shard,
                  "queue.id": row.queue_id,
                  "memory.id": row.memory_id,
                  "memory.embedding_version": row.embedding_version,
                },
                callback: async () => {
                  const result = resultMap.get(row.memory_id);

                  if (!result || result.error) {
                    // Embedding failed — record error, leave outcome NULL for retry
                    // Queue row may be CASCADE-deleted if memory was deleted; 0 rows is fine
                    const error =
                      result?.error ?? "No embedding result returned";
                    info("Embedding result failed, updating queue", {
                      "worker.schema": schema,
                      "worker.shard": shard,
                      "queue.id": row.queue_id,
                      "memory.id": row.memory_id,
                      "embedding.error": error,
                    });
                    await tx.unsafe(
                      `UPDATE ${schema}.embedding_queue
                       SET last_error = $1
                         , outcome = CASE WHEN attempts >= max_attempts THEN 'failed' END
                       WHERE id = $2`,
                      [error, row.queue_id],
                    );
                    failed++;
                    return;
                  }

                  // Version-guarded write to memory
                  const vecLiteral = `[${result.embedding.join(",")}]`;
                  info("Embedding memory update starting", {
                    "worker.schema": schema,
                    "worker.shard": shard,
                    "queue.id": row.queue_id,
                    "memory.id": row.memory_id,
                    "memory.embedding_version": row.embedding_version,
                  });
                  const updated = await tx.unsafe(
                    `UPDATE ${schema}.memory
                     SET embedding = $1::halfvec
                     WHERE id = $2 AND embedding_version = $3
                     RETURNING id`,
                    [vecLiteral, row.memory_id, row.embedding_version],
                  );
                  info("Embedding memory update finished", {
                    "worker.schema": schema,
                    "worker.shard": shard,
                    "queue.id": row.queue_id,
                    "memory.id": row.memory_id,
                    "memory.rows_updated": updated.length,
                  });

                  if (updated.length === 0) {
                    // Content changed or memory deleted between claim and embed — cancel
                    // Queue row may already be CASCADE-deleted; 0 rows updated is fine
                    info("Embedding queue cancellation starting", {
                      "worker.schema": schema,
                      "worker.shard": shard,
                      "queue.id": row.queue_id,
                      "memory.id": row.memory_id,
                    });
                    await tx.unsafe(
                      `UPDATE ${schema}.embedding_queue
                       SET outcome = 'cancelled'
                       WHERE id = $1`,
                      [row.queue_id],
                    );
                    succeeded++;
                  } else {
                    // Embedding written — mark completed
                    // Queue row may be CASCADE-deleted if memory deleted between these two
                    // statements; 0 rows updated is fine
                    info("Embedding queue completion starting", {
                      "worker.schema": schema,
                      "worker.shard": shard,
                      "queue.id": row.queue_id,
                      "memory.id": row.memory_id,
                    });
                    await tx.unsafe(
                      `UPDATE ${schema}.embedding_queue
                       SET outcome = 'completed'
                       WHERE id = $1`,
                      [row.queue_id],
                    );
                    succeeded++;
                  }
                  info("Embedding queue update finished", {
                    "worker.schema": schema,
                    "worker.shard": shard,
                    "queue.id": row.queue_id,
                    "memory.id": row.memory_id,
                  });
                },
              });
            }
          });
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
