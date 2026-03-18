import { generateEmbeddings } from "@memory-engine/embedding";
import type { SQL } from "bun";
import type { ProcessResult, WorkerConfig } from "./types";

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
  schema: string,
  config: WorkerConfig,
): Promise<ProcessResult> {
  const batchSize = config.batchSize ?? 10;
  const lockDuration = config.lockDuration ?? "5 minutes";

  // --- Claim ---
  const claimed = await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO ${schema}, public`);
    await tx.unsafe("SET LOCAL ROLE me_embed");
    return tx.unsafe(
      `SELECT * FROM ${schema}.claim_embedding_batch($1, $2::interval)`,
      [batchSize, lockDuration],
    ) as Promise<ClaimedRow[]>;
  });

  if (claimed.length === 0) {
    return { claimed: 0, succeeded: 0, failed: 0 };
  }

  // --- Embed ---
  const rows = claimed.map((r) => ({ id: r.memory_id, content: r.content }));
  const embedResults = await generateEmbeddings(rows, config.embedding);

  // Build lookup: memory_id → embed result
  const resultMap = new Map(embedResults.map((r) => [r.id, r]));

  // --- Write-back ---
  let succeeded = 0;
  let failed = 0;

  await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO ${schema}, public`);
    await tx.unsafe("SET LOCAL ROLE me_embed");

    for (const row of claimed) {
      const result = resultMap.get(row.memory_id);

      if (!result || result.error) {
        // Embedding failed — record error, leave outcome NULL for retry
        const error = result?.error ?? "No embedding result returned";
        await tx.unsafe(
          `UPDATE ${schema}.embedding_queue
           SET last_error = $1
           WHERE id = $2`,
          [error, row.queue_id],
        );
        failed++;
        continue;
      }

      // Version-guarded write to memory
      const vecLiteral = `[${result.embedding.join(",")}]`;
      const updated = await tx.unsafe(
        `UPDATE ${schema}.memory
         SET embedding = $1::halfvec
         WHERE id = $2 AND embedding_version = $3
         RETURNING id`,
        [vecLiteral, row.memory_id, row.embedding_version],
      );

      if (updated.length === 0) {
        // Content changed between claim and embed — cancel
        await tx.unsafe(
          `UPDATE ${schema}.embedding_queue
           SET outcome = 'cancelled'
           WHERE id = $1`,
          [row.queue_id],
        );
        // Still counts as "succeeded" from worker perspective (handled correctly)
        succeeded++;
      } else {
        // Embedding written — mark completed
        await tx.unsafe(
          `UPDATE ${schema}.embedding_queue
           SET outcome = 'completed'
           WHERE id = $1`,
          [row.queue_id],
        );
        succeeded++;
      }
    }
  });

  return { claimed: claimed.length, succeeded, failed };
}
