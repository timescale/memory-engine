import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createEngineDB } from "@memory-engine/engine/db";
import { bootstrap } from "@memory-engine/engine/migrate/bootstrap";
import { provisionEngine } from "@memory-engine/engine/migrate/provision";
import { TestDatabase } from "@memory-engine/engine/migrate/test-utils";
import { SQL } from "bun";
import { processBatch } from "./process";
import type { WorkerConfig } from "./types";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const testDb = new TestDatabase();
let connectionString: string;
let sql: SQL;
const slug = "tstworker001";
const schema = `me_${slug}`;

/** Minimal config with a mock embedding provider (never actually called for claim tests) */
function mockConfig(
  embedFn: (
    rows: Array<{ id: string; content: string }>,
  ) => Promise<Array<{ id: string; embedding: number[]; error?: string }>>,
): WorkerConfig {
  return {
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    },
    batchSize: 10,
    // We'll monkey-patch generateEmbeddings in the test via a wrapper
  };
}

beforeAll(async () => {
  connectionString = await testDb.create();
  sql = new SQL(connectionString);
  await bootstrap(sql);
  await provisionEngine(sql, slug, undefined, "0.0.0-test");

  // Create a superuser principal for inserting memories
  const db = createEngineDB(sql, schema);
  const su = await db.createSuperuser("worker-test-admin");
  db.setPrincipal(su.id);

  // Grant me_embed SELECT/UPDATE on memory (already done by migration 005)
  // but we need to ensure the embedding_queue trigger is active
});

afterAll(async () => {
  await sql.close();
  await testDb.drop();
});

// ---------------------------------------------------------------------------
// Helper: insert a memory and return its id + queue state
// ---------------------------------------------------------------------------

async function insertMemory(content: string): Promise<string> {
  const db = createEngineDB(sql, schema);
  const su = await db.getPrincipalByName("worker-test-admin");
  db.setPrincipal(su!.id);
  const memory = await db.createMemory({ content, tree: "test.worker" });
  return memory.id;
}

async function getQueueEntries(memoryId: string) {
  return sql.unsafe(
    `SELECT * FROM ${schema}.embedding_queue WHERE memory_id = $1 ORDER BY id`,
    [memoryId],
  );
}

async function getMemoryEmbedding(memoryId: string) {
  const [row] = await sql.unsafe(
    `SELECT embedding, embedding_version FROM ${schema}.memory WHERE id = $1`,
    [memoryId],
  );
  return row;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processBatch integration", () => {
  test("processes queue entries and writes embeddings", async () => {
    const memoryId = await insertMemory("Hello world embedding test");

    // Verify queue entry was created by trigger
    const queueBefore = await getQueueEntries(memoryId);
    expect(queueBefore.length).toBeGreaterThanOrEqual(1);
    expect(queueBefore[0].outcome).toBeNull();

    // We need to mock generateEmbeddings at the module level
    // Instead, use a real-ish approach: create a processBatch wrapper
    // that intercepts. For integration test, we'll use the actual processBatch
    // but with a test embedding provider.

    // Create a mock embedding server using Bun.serve
    const mockEmbedding = Array.from({ length: 1536 }, (_, i) => i * 0.001);
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        return Response.json({
          object: "list",
          data: [{ object: "embedding", embedding: mockEmbedding, index: 0 }],
          model: "text-embedding-3-small",
          usage: { prompt_tokens: 5, total_tokens: 5 },
        });
      },
    });

    try {
      const config: WorkerConfig = {
        embedding: {
          provider: "openai",
          model: "text-embedding-3-small",
          dimensions: 1536,
          apiKey: "test-key",
          baseUrl: `http://localhost:${server.port}/v1`,
        },
        batchSize: 10,
      };

      const result = await processBatch(sql, schema, config);

      expect(result.claimed).toBeGreaterThanOrEqual(1);
      expect(result.succeeded).toBeGreaterThanOrEqual(1);
      expect(result.failed).toBe(0);

      // Verify embedding was written
      const mem = await getMemoryEmbedding(memoryId);
      expect(mem.embedding).toBeDefined();

      // Verify queue entry marked completed
      const queueAfter = await getQueueEntries(memoryId);
      const completed = queueAfter.find(
        (q: Record<string, unknown>) => q.outcome === "completed",
      );
      expect(completed).toBeDefined();
    } finally {
      server.stop();
    }
  });

  test("handles stale version (content changed during embed)", async () => {
    const memoryId = await insertMemory("Original content for version test");

    // Manually bump embedding_version to simulate content change after claim
    // First, process to clear the initial queue entry
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          object: "list",
          data: [
            {
              object: "embedding",
              embedding: Array.from({ length: 1536 }, (_, i) => i * 0.001),
              index: 0,
            },
          ],
          model: "text-embedding-3-small",
          usage: { prompt_tokens: 5, total_tokens: 5 },
        });
      },
    });

    try {
      const config: WorkerConfig = {
        embedding: {
          provider: "openai",
          model: "text-embedding-3-small",
          dimensions: 1536,
          apiKey: "test-key",
          baseUrl: `http://localhost:${server.port}/v1`,
        },
        batchSize: 10,
      };

      // Clear any pending entries first
      await processBatch(sql, schema, config);

      // Now insert a new memory and manually create a stale queue entry
      const staleId = await insertMemory("Stale version content");

      // Bump the memory's embedding_version to make queue entry stale
      await sql.unsafe(
        `UPDATE ${schema}.memory SET embedding_version = embedding_version + 1 WHERE id = $1`,
        [staleId],
      );

      const result = await processBatch(sql, schema, config);
      expect(result.claimed).toBeGreaterThanOrEqual(1);

      // Queue entry should be cancelled (version mismatch)
      const queue = await getQueueEntries(staleId);
      const cancelled = queue.find(
        (q: Record<string, unknown>) => q.outcome === "cancelled",
      );
      expect(cancelled).toBeDefined();
    } finally {
      server.stop();
    }
  });

  test("handles embedding errors gracefully", async () => {
    const memoryId = await insertMemory("Error test content");

    // Mock server that returns an error
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({
            error: { message: "Rate limited", type: "rate_limit_error" },
          }),
          { status: 429 },
        );
      },
    });

    try {
      const config: WorkerConfig = {
        embedding: {
          provider: "openai",
          model: "text-embedding-3-small",
          dimensions: 1536,
          apiKey: "test-key",
          baseUrl: `http://localhost:${server.port}/v1`,
          options: { maxRetries: 0 },
        },
        batchSize: 10,
      };

      const result = await processBatch(sql, schema, config);

      expect(result.claimed).toBeGreaterThanOrEqual(1);
      expect(result.failed).toBeGreaterThanOrEqual(1);

      // Queue entry should still have NULL outcome (for retry) but have last_error set
      const queue = await getQueueEntries(memoryId);
      const entry = queue.find(
        (q: Record<string, unknown>) => q.outcome === null && q.last_error,
      );
      expect(entry).toBeDefined();
      expect(entry.last_error).toBeTruthy();
    } finally {
      server.stop();
    }
  });

  test("returns zero when queue is empty", async () => {
    // Use a dedicated config pointing at a mock server that should never be called
    const config: WorkerConfig = {
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        apiKey: "test-key",
        baseUrl: "http://localhost:1/v1",
      },
      batchSize: 10,
    };

    // Clear all pending queue entries first
    await sql.unsafe(
      `UPDATE ${schema}.embedding_queue SET outcome = 'completed' WHERE outcome IS NULL`,
    );

    const result = await processBatch(sql, schema, config);
    expect(result.claimed).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
  });
});
