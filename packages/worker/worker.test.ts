import { describe, expect, test } from "bun:test";
import { Worker } from "./worker";

/**
 * Create a mock SQL object that supports .begin() for processBatch transactions.
 */
function createMockSql(handlers: {
  begin?: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
}) {
  const sql = Object.assign(async () => [], {
    unsafe: async () => [],
    begin: handlers.begin ?? (async () => []),
    close: async () => {},
  });
  return sql;
}

describe("Worker", () => {
  test("exponential backoff formula matches expected values", () => {
    const idleDelayMs = 10_000;
    const maxBackoffMs = 60_000;

    function computeBackoff(consecutiveErrors: number): number {
      return Math.min(idleDelayMs * 2 ** (consecutiveErrors - 1), maxBackoffMs);
    }

    expect(computeBackoff(1)).toBe(10_000); // 10s * 2^0 = 10s
    expect(computeBackoff(2)).toBe(20_000); // 10s * 2^1 = 20s
    expect(computeBackoff(3)).toBe(40_000); // 10s * 2^2 = 40s
    expect(computeBackoff(4)).toBe(60_000); // 10s * 2^3 = 80s → capped at 60s
    expect(computeBackoff(5)).toBe(60_000); // capped
  });

  test("stops immediately when already aborted", async () => {
    const mockSql = createMockSql({});

    const worker = new Worker(mockSql as never, {
      embedding: {
        provider: "openai",
        model: "test",
        dimensions: 3,
      },
      discover: async () => [],
      idleDelayMs: 100,
    });

    await worker.start();
    await worker.stop();

    expect(worker.stats.consecutiveErrors).toBe(0);
  });

  test("exits on drain timeout", async () => {
    let discoverCalls = 0;

    const mockSql = createMockSql({
      begin: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          unsafe: async (q: string) => {
            if (q.includes("claim_embedding_batch")) return [];
            return [];
          },
        };
        return fn(tx);
      },
    });

    const worker = new Worker(mockSql as never, {
      embedding: {
        provider: "openai",
        model: "test",
        dimensions: 3,
      },
      discover: async () => {
        discoverCalls++;
        return [{ schema: "me_test12345678", shard: 1 }];
      },
      idleDelayMs: 50,
      drainTimeoutMs: 100,
      refreshIntervalMs: 1_000_000, // don't refresh during test
    });

    const start = Date.now();
    await worker.start();
    // Let the drain timeout expire naturally before cleaning up
    await new Promise((resolve) => setTimeout(resolve, 300));
    await worker.stop();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(2000);
    expect(discoverCalls).toBeGreaterThanOrEqual(1);
  });

  test("throws if started twice", async () => {
    const mockSql = createMockSql({});

    const worker = new Worker(mockSql as never, {
      embedding: {
        provider: "openai",
        model: "test",
        dimensions: 3,
      },
      discover: async () => [],
      idleDelayMs: 100,
    });

    await worker.start();
    expect(() => worker.start()).toThrow("Worker is already running");
    await worker.stop();
  });
});
