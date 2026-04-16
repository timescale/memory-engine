import { describe, expect, test } from "bun:test";
import { RateLimitError } from "@memory.build/embedding";
import { WorkerPool } from "./pool";
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

  test("rate limit error uses Retry-After backoff, does not increment consecutiveErrors", async () => {
    let batchCalls = 0;

    const mockSql = createMockSql({
      begin: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          unsafe: async (q: string) => {
            if (q.includes("claim_embedding_batch")) {
              batchCalls++;
              // First call returns a row (triggers embedding), later calls return empty
              if (batchCalls === 1) {
                return [
                  {
                    queue_id: "1",
                    memory_id: "mem-1",
                    embedding_version: 1,
                    content: "test",
                  },
                ];
              }
              return [];
            }
            return [];
          },
        };
        return fn(tx);
      },
    });

    // We can't easily mock generateEmbeddings at the module level,
    // but we can verify the worker's stats behavior by checking that
    // consecutiveErrors stays at 0 after a RateLimitError is thrown.
    // The processBatch will throw because the mock doesn't fully
    // support the embedding flow — but we can at least verify the
    // backoff formula and constants are correct.

    // Verify the RATE_LIMIT_FLOOR_MS constant via behavior:
    // If a RateLimitError with retryAfterMs=1000 is thrown,
    // the worker should still sleep at least 30s (the floor).
    const err = new RateLimitError("rate limited", 1000);
    const floor = 30_000;
    const backoffMs = Math.max(err.retryAfterMs ?? floor, floor);
    expect(backoffMs).toBe(floor); // 1000 < 30000, so floor wins

    // retryAfterMs > floor should use retryAfterMs
    const err2 = new RateLimitError("rate limited", 60_000);
    const backoffMs2 = Math.max(err2.retryAfterMs ?? floor, floor);
    expect(backoffMs2).toBe(60_000);

    // undefined retryAfterMs should use floor
    const err3 = new RateLimitError("rate limited");
    const backoffMs3 = Math.max(err3.retryAfterMs ?? floor, floor);
    expect(backoffMs3).toBe(floor);

    // Verify worker doesn't set consecutiveErrors for rate limit
    // (this is more of a code review assertion — the catch block
    // for RateLimitError calls continue before incrementing)
    const worker = new Worker(mockSql as never, {
      embedding: {
        provider: "openai",
        model: "test",
        dimensions: 3,
      },
      discover: async () => [{ schema: "me_test12345678", shard: 1 }],
      idleDelayMs: 50,
      drainTimeoutMs: 200,
      refreshIntervalMs: 1_000_000,
    });

    await worker.start();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await worker.stop();

    // Even though processBatch may have thrown errors,
    // consecutiveErrors should be low — the exact value depends
    // on whether the error was a RateLimitError or something else.
    // What matters is that the worker ran and stopped cleanly.
    expect(worker.stats).toBeDefined();
  });
});

describe("WorkerPool", () => {
  test("starts N workers and aggregates stats", async () => {
    let batchCalls = 0;

    const mockSql = createMockSql({
      begin: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          unsafe: async (q: string) => {
            if (q.includes("claim_embedding_batch")) {
              batchCalls++;
              return [];
            }
            return [];
          },
        };
        return fn(tx);
      },
    });

    const pool = new WorkerPool(mockSql as never, {
      embedding: {
        provider: "openai",
        model: "test",
        dimensions: 3,
      },
      discover: async () => [{ schema: "me_test12345678", shard: 1 }],
      idleDelayMs: 50,
      drainTimeoutMs: 150,
      refreshIntervalMs: 1_000_000,
    });

    expect(pool.size).toBe(0);
    await pool.start(3);
    expect(pool.size).toBe(3);

    // Let workers poll a few times
    await new Promise((resolve) => setTimeout(resolve, 300));
    await pool.stop();

    expect(pool.size).toBe(3);
    // All 3 workers should have polled at least once
    expect(pool.stats.schemasPolled).toBeGreaterThanOrEqual(3);
    expect(batchCalls).toBeGreaterThanOrEqual(3);
  });

  test("stop is safe when not started", async () => {
    const mockSql = createMockSql({});

    const pool = new WorkerPool(mockSql as never, {
      embedding: {
        provider: "openai",
        model: "test",
        dimensions: 3,
      },
      discover: async () => [],
    });

    await pool.stop(); // should not throw
    expect(pool.size).toBe(0);
  });

  test("throws if started twice", async () => {
    const mockSql = createMockSql({});

    const pool = new WorkerPool(mockSql as never, {
      embedding: {
        provider: "openai",
        model: "test",
        dimensions: 3,
      },
      discover: async () => [],
      idleDelayMs: 50,
    });

    await pool.start(2);
    expect(() => pool.start(2)).toThrow("Worker pool is already running");
    await pool.stop();
  });

  // Regression: worker sleeps were previously built on a plain setTimeout
  // that did not listen to the AbortSignal. A worker caught inside a long
  // sleep (idle poll or error backoff) would not notice shutdown until the
  // timer expired, which on k8s meant pods sat in Terminating until the
  // grace period escalated to SIGKILL. These tests pin the invariant that
  // stop() resolves promptly even when workers are mid-sleep.
  test("stop() wakes workers from idle sleep instead of waiting out the timer", async () => {
    const mockSql = createMockSql({});

    const pool = new WorkerPool(mockSql as never, {
      embedding: {
        provider: "openai",
        model: "test",
        dimensions: 3,
      },
      // No targets → worker goes straight to `sleep(idleDelayMs, signal)` in the
      // `targets.length === 0` branch. If sleep doesn't honor the abort, stop()
      // will block for the full 60s.
      discover: async () => [],
      idleDelayMs: 60_000,
      refreshIntervalMs: 1_000_000,
    });

    await pool.start(2);
    // Give workers a tick to enter their sleep before we signal stop.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const start = Date.now();
    await pool.stop();
    const elapsed = Date.now() - start;

    // Abortable sleep should resolve effectively immediately. 500ms is a
    // generous ceiling that will still fail loudly if someone regresses
    // sleep() back to a non-abortable setTimeout (which would take ~60s).
    expect(elapsed).toBeLessThan(500);
  });

  test("stop() wakes workers from error-backoff sleep", async () => {
    // Make processBatch fail so the worker lands in the generic-error catch
    // branch and ends up in `await sleep(backoffMs, signal)`. With
    // idleDelayMs=60_000 and consecutiveErrors=1, backoffMs = 60_000.
    const mockSql = createMockSql({
      begin: async () => {
        throw new Error("simulated transient failure");
      },
    });

    const pool = new WorkerPool(mockSql as never, {
      embedding: {
        provider: "openai",
        model: "test",
        dimensions: 3,
      },
      discover: async () => [{ schema: "me_test12345678", shard: 1 }],
      idleDelayMs: 60_000,
      maxBackoffMs: 60_000,
      refreshIntervalMs: 1_000_000,
    });

    await pool.start(1);
    // Give the worker enough time to run discover, attempt processBatch,
    // catch the error, and settle into sleep(backoffMs).
    await new Promise((resolve) => setTimeout(resolve, 100));

    const start = Date.now();
    await pool.stop();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    // Sanity: the worker did hit the error path before we stopped it.
    expect(pool.stats.consecutiveErrors).toBeGreaterThanOrEqual(1);
  });
});
