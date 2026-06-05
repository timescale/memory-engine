import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  bootstrapSpaceDatabase,
  generateSlug,
  migrateSpace,
  slugToSchema,
} from "@memory.build/database";
import { RateLimitError } from "@memory.build/embedding";
import postgres, { type Sql } from "postgres";
import { processBatch, pruneQueue } from "./process";
import type { SpaceTarget, WorkerConfig } from "./types";

// ---------------------------------------------------------------------------
// Test setup — a real space schema (me_<slug>) on the new-model pool.
// ---------------------------------------------------------------------------

const URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/postgres";

let sql: Sql;
let slug: string;
let schema: string;
let target: SpaceTarget;
const discover = async () => [target];

/** A config whose embedding calls hit the given mock base URL. */
function mockConfig(baseUrl: string, maxRetries?: number): WorkerConfig {
  return {
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      apiKey: "test-key",
      baseUrl,
      ...(maxRetries !== undefined ? { options: { maxRetries } } : {}),
    },
    discover,
    batchSize: 10,
  };
}

/** A mock OpenAI embeddings server returning a fixed vector. */
function embedServer(): ReturnType<typeof Bun.serve> {
  const embedding = Array.from({ length: 1536 }, (_, i) => i * 0.001);
  return Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        object: "list",
        data: [{ object: "embedding", embedding, index: 0 }],
        model: "text-embedding-3-small",
        usage: { prompt_tokens: 5, total_tokens: 5 },
      });
    },
  });
}

async function insertMemory(content: string): Promise<string> {
  const [row] = await sql.unsafe(
    `INSERT INTO ${schema}.memory (content, tree) VALUES ($1, ''::ltree) RETURNING id`,
    [content],
  );
  return row?.id as string;
}

function getQueueEntries(memoryId: string) {
  return sql.unsafe(
    `SELECT * FROM ${schema}.embedding_queue WHERE memory_id = $1 ORDER BY id`,
    [memoryId],
  ) as Promise<Record<string, unknown>[]>;
}

async function clearPending() {
  await sql.unsafe(
    `UPDATE ${schema}.embedding_queue SET outcome = 'completed' WHERE outcome IS NULL`,
  );
}

beforeAll(async () => {
  sql = postgres(URL, { onnotice: () => {} });
  slug = generateSlug();
  schema = slugToSchema(slug);
  target = { schema };
  await bootstrapSpaceDatabase(sql);
  await migrateSpace(sql, { slug });
});

afterAll(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await sql.end();
});

describe("processBatch integration (space model)", () => {
  beforeEach(clearPending);

  test("processes queue entries and writes embeddings", async () => {
    const memoryId = await insertMemory("Hello world embedding test");

    const queueBefore = await getQueueEntries(memoryId);
    expect(queueBefore.length).toBeGreaterThanOrEqual(1);
    expect(queueBefore[0]?.outcome).toBeNull();

    const server = embedServer();
    try {
      const result = await processBatch(
        sql,
        target,
        mockConfig(`http://localhost:${server.port}/v1`),
      );
      expect(result.claimed).toBeGreaterThanOrEqual(1);
      expect(result.succeeded).toBeGreaterThanOrEqual(1);
      expect(result.failed).toBe(0);

      const [mem] = await sql.unsafe(
        `SELECT embedding FROM ${schema}.memory WHERE id = $1`,
        [memoryId],
      );
      expect(mem?.embedding).toBeDefined();

      const queueAfter = await getQueueEntries(memoryId);
      expect(queueAfter.some((q) => q.outcome === "completed")).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("cancels stale version at claim time", async () => {
    const staleId = await insertMemory("Stale version content");
    // Bump the memory's version so the queued row (v1) is stale.
    await sql.unsafe(
      `UPDATE ${schema}.memory SET embedding_version = embedding_version + 1 WHERE id = $1`,
      [staleId],
    );

    const server = embedServer();
    try {
      const result = await processBatch(
        sql,
        target,
        mockConfig(`http://localhost:${server.port}/v1`),
      );
      expect(result.claimed).toBe(0);
      const queue = await getQueueEntries(staleId);
      expect(queue.some((q) => q.outcome === "cancelled")).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("non-rate-limit error records last_error, leaves outcome NULL for retry", async () => {
    const memoryId = await insertMemory("Error test content");
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({
            error: { message: "Invalid input", type: "invalid_request_error" },
          }),
          { status: 400 },
        );
      },
    });
    try {
      const result = await processBatch(
        sql,
        target,
        mockConfig(`http://localhost:${server.port}/v1`, 0),
      );
      expect(result.claimed).toBeGreaterThanOrEqual(1);
      expect(result.failed).toBeGreaterThanOrEqual(1);

      const queue = await getQueueEntries(memoryId);
      const entry = queue.find((q) => q.outcome === null && q.last_error);
      expect(entry).toBeDefined();
      expect(entry?.last_error).toBeTruthy();
    } finally {
      server.stop();
    }
  });

  test("rate limit (429) throws RateLimitError and decrements attempts", async () => {
    const memoryId = await insertMemory("Rate limit test content");
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({
            error: { message: "Rate limited", type: "rate_limit_error" },
          }),
          { status: 429, headers: { "retry-after-ms": "5000" } },
        );
      },
    });
    try {
      await expect(
        processBatch(
          sql,
          target,
          mockConfig(`http://localhost:${server.port}/v1`, 0),
        ),
      ).rejects.toBeInstanceOf(RateLimitError);

      // claim incremented attempts to 1 and locked the row (vt in the future);
      // the RateLimitError handler released it — attempts back to 0 (the
      // transient failure isn't charged) and vt reset so it's immediately
      // claimable again rather than waiting out the full claim lock.
      const queue = await getQueueEntries(memoryId);
      const entry = queue.find((q) => q.outcome === null);
      expect(entry?.attempts).toBe(0);
      expect((entry?.vt as Date).getTime()).toBeLessThanOrEqual(Date.now());
    } finally {
      server.stop();
    }
  });

  test("claim sweeps exhausted rows to 'failed'", async () => {
    const memoryId = await insertMemory("Exhausted attempts content");
    // Simulate a crash that left the row at max attempts with an expired lock.
    await sql.unsafe(
      `UPDATE ${schema}.embedding_queue
       SET attempts = 3, vt = now() - interval '1 minute'
       WHERE memory_id = $1 AND outcome IS NULL`,
      [memoryId],
    );

    // Base URL is never reached — the row is swept, not embedded.
    const result = await processBatch(
      sql,
      target,
      mockConfig("http://localhost:1/v1"),
    );
    expect(result.claimed).toBe(0);

    const queue = await getQueueEntries(memoryId);
    const entry = queue.find((q) => q.outcome === "failed");
    expect(entry).toBeDefined();
    expect(String(entry?.last_error)).toContain("exceeded max attempts");
  });

  test("cancels superseded versions, embeds only the latest", async () => {
    const memoryId = await insertMemory("claim-time v1");
    await sql.unsafe(`UPDATE ${schema}.memory SET content = $1 WHERE id = $2`, [
      "claim-time v2",
      memoryId,
    ]);
    await sql.unsafe(`UPDATE ${schema}.memory SET content = $1 WHERE id = $2`, [
      "claim-time v3",
      memoryId,
    ]);

    const pending = (await getQueueEntries(memoryId)).filter(
      (q) => q.outcome === null,
    );
    expect(pending.length).toBe(3);

    let embedCalls = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        embedCalls++;
        return Response.json({
          object: "list",
          data: [
            {
              object: "embedding",
              embedding: Array.from({ length: 1536 }, () => 0),
              index: 0,
            },
          ],
          model: "text-embedding-3-small",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      },
    });
    try {
      const result = await processBatch(
        sql,
        target,
        mockConfig(`http://localhost:${server.port}/v1`),
      );
      expect(result.claimed).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(embedCalls).toBe(1);

      const queueAfter = await getQueueEntries(memoryId);
      expect(queueAfter.filter((q) => q.outcome === "cancelled").length).toBe(
        2,
      );
      expect(queueAfter.filter((q) => q.outcome === "completed").length).toBe(
        1,
      );
    } finally {
      server.stop();
    }
  });

  test("deleted memory: queue row CASCADE-deleted, nothing to claim", async () => {
    const memoryId = await insertMemory("Delete claim-time test");
    await sql.unsafe(`DELETE FROM ${schema}.memory WHERE id = $1`, [memoryId]);
    expect((await getQueueEntries(memoryId)).length).toBe(0);

    const result = await processBatch(
      sql,
      target,
      mockConfig("http://localhost:1/v1"),
    );
    expect(result.claimed).toBe(0);
  });

  test("pruneQueue deletes terminal rows older than retention", async () => {
    await sql.unsafe(`DELETE FROM ${schema}.embedding_queue`);
    const memoryId = await insertMemory("Prune helper test memory");
    await sql.unsafe(`DELETE FROM ${schema}.embedding_queue`);

    await sql.unsafe(
      `INSERT INTO ${schema}.embedding_queue
        (memory_id, embedding_version, outcome, created_at)
       VALUES ($1, 1, 'completed', now() - interval '10 days'),
              ($1, 2, 'failed',    now() - interval '10 days'),
              ($1, 3, 'cancelled', now() - interval '10 days'),
              ($1, 4, 'completed', now() - interval '1 day'),
              ($1, 5, null,        now() - interval '30 days')`,
      [memoryId],
    );

    const pruned = await pruneQueue(sql, target, "7 days");
    expect(pruned).toBe(3);

    const remaining = (await sql.unsafe(
      `SELECT embedding_version, outcome FROM ${schema}.embedding_queue
       WHERE memory_id = $1 ORDER BY embedding_version`,
      [memoryId],
    )) as { embedding_version: number; outcome: string | null }[];
    expect(remaining).toHaveLength(2);
    expect(remaining[0]?.embedding_version).toBe(4);
    expect(remaining[1]?.embedding_version).toBe(5);
    expect(remaining[1]?.outcome).toBeNull();
  });

  test("pruneQueue is a no-op when nothing matches", async () => {
    await sql.unsafe(`DELETE FROM ${schema}.embedding_queue`);
    expect(await pruneQueue(sql, target, "7 days")).toBe(0);
  });

  test("returns zero when queue is empty", async () => {
    const result = await processBatch(
      sql,
      target,
      mockConfig("http://localhost:1/v1"),
    );
    expect(result).toEqual({ claimed: 0, succeeded: 0, failed: 0 });
  });
});

describe("write-back SQL functions", () => {
  beforeEach(clearPending);

  const zeroVec = `[${Array.from({ length: 1536 }, () => 0).join(",")}]`;

  async function pendingRow(content: string) {
    const memoryId = await insertMemory(content);
    const [q] = await getQueueEntries(memoryId);
    return {
      memoryId,
      queueId: q?.id as string,
      version: Number(q?.embedding_version),
    };
  }

  test("complete_embedding writes the vector and marks 'completed' on a version match", async () => {
    const { memoryId, queueId, version } = await pendingRow("complete me");

    const [r] = (await sql.unsafe(
      `SELECT ${schema}.complete_embedding($1, $2, $3, $4::halfvec) AS outcome`,
      [queueId, memoryId, version, zeroVec],
    )) as { outcome: string }[];
    expect(r?.outcome).toBe("completed");

    const [mem] = await sql.unsafe(
      `SELECT embedding FROM ${schema}.memory WHERE id = $1`,
      [memoryId],
    );
    expect(mem?.embedding).not.toBeNull();
    const [q] = await getQueueEntries(memoryId);
    expect(q?.outcome).toBe("completed");
  });

  test("complete_embedding cancels (no write) when the version no longer matches", async () => {
    const { memoryId, queueId, version } = await pendingRow("superseded");

    const [r] = (await sql.unsafe(
      `SELECT ${schema}.complete_embedding($1, $2, $3, $4::halfvec) AS outcome`,
      [queueId, memoryId, version + 1, zeroVec], // stale version
    )) as { outcome: string }[];
    expect(r?.outcome).toBe("cancelled");

    const [mem] = await sql.unsafe(
      `SELECT embedding FROM ${schema}.memory WHERE id = $1`,
      [memoryId],
    );
    expect(mem?.embedding).toBeNull(); // not written
    const [q] = await getQueueEntries(memoryId);
    expect(q?.outcome).toBe("cancelled");
  });

  test("fail_embedding records last_error and leaves outcome NULL; no-op once terminal", async () => {
    const { memoryId, queueId } = await pendingRow("fail me");

    await sql.unsafe(`SELECT ${schema}.fail_embedding($1, $2)`, [
      queueId,
      "boom",
    ]);
    let [q] = await getQueueEntries(memoryId);
    expect(q?.outcome).toBeNull();
    expect(q?.last_error).toBe("boom");

    // Finalize, then a later fail must not touch the terminal row.
    await sql.unsafe(
      `UPDATE ${schema}.embedding_queue SET outcome = 'completed' WHERE id = $1`,
      [queueId],
    );
    await sql.unsafe(`SELECT ${schema}.fail_embedding($1, $2)`, [
      queueId,
      "later",
    ]);
    [q] = await getQueueEntries(memoryId);
    expect(q?.outcome).toBe("completed");
    expect(q?.last_error).toBe("boom"); // unchanged
  });

  test("release_embedding decrements attempts, resets vt, floors at 0, no-op once terminal", async () => {
    const { memoryId, queueId } = await pendingRow("release me");
    // Simulate a claim: attempt charged + locked (vt pushed into the future).
    await sql.unsafe(
      `UPDATE ${schema}.embedding_queue
       SET attempts = 2, vt = now() + interval '5 minutes' WHERE id = $1`,
      [queueId],
    );

    await sql.unsafe(`SELECT ${schema}.release_embedding($1)`, [queueId]);
    const [released] = (await sql.unsafe(
      `SELECT attempts, (vt <= now()) AS claimable
       FROM ${schema}.embedding_queue WHERE id = $1`,
      [queueId],
    )) as { attempts: number; claimable: boolean }[];
    expect(Number(released?.attempts)).toBe(1);
    expect(released?.claimable).toBe(true); // vt reset → eligible again now

    // Floors at 0.
    await sql.unsafe(
      `UPDATE ${schema}.embedding_queue SET attempts = 0 WHERE id = $1`,
      [queueId],
    );
    await sql.unsafe(`SELECT ${schema}.release_embedding($1)`, [queueId]);
    expect(Number((await getQueueEntries(memoryId))[0]?.attempts)).toBe(0);

    // No-op once terminal.
    await sql.unsafe(
      `UPDATE ${schema}.embedding_queue
       SET outcome = 'completed', attempts = 5 WHERE id = $1`,
      [queueId],
    );
    await sql.unsafe(`SELECT ${schema}.release_embedding($1)`, [queueId]);
    expect(Number((await getQueueEntries(memoryId))[0]?.attempts)).toBe(5);
  });
});
