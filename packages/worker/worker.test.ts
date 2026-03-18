import { describe, expect, test } from "bun:test";

/**
 * Create a mock SQL object that supports both tagged-template and .unsafe() calls.
 * discoverEngineSchemas uses sql`...` (tagged template), while processBatch uses sql.begin().
 */
function createMockSql(handlers: {
  tagged?: () => Promise<unknown[]>;
  unsafe?: (query: string, params?: unknown[]) => Promise<unknown[]>;
  begin?: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
}) {
  // The SQL object itself is callable as a tagged template
  const sql = Object.assign(
    async () => handlers.tagged?.() ?? [],
    {
      unsafe: handlers.unsafe ?? (async () => []),
      begin: handlers.begin ?? (async () => []),
      close: async () => {},
    },
  );
  return sql;
}

describe("worker backoff logic", () => {
  test("exponential backoff formula matches expected values", () => {
    const idleDelayMs = 10_000;
    const maxBackoffMs = 60_000;

    function computeBackoff(consecutiveErrors: number): number {
      return Math.min(
        idleDelayMs * 2 ** (consecutiveErrors - 1),
        maxBackoffMs,
      );
    }

    expect(computeBackoff(1)).toBe(10_000); // 10s * 2^0 = 10s
    expect(computeBackoff(2)).toBe(20_000); // 10s * 2^1 = 20s
    expect(computeBackoff(3)).toBe(40_000); // 10s * 2^2 = 40s
    expect(computeBackoff(4)).toBe(60_000); // 10s * 2^3 = 80s → capped at 60s
    expect(computeBackoff(5)).toBe(60_000); // capped
  });

  test("runDaemon exits on abort signal", async () => {
    const { runDaemon } = await import("./worker");

    const mockSql = createMockSql({
      tagged: async () => [], // discoverEngineSchemas returns no schemas
    });

    const abort = new AbortController();
    abort.abort();

    await runDaemon(mockSql as never, {
      embedding: {
        provider: "openai",
        model: "test",
        dimensions: 3,
      },
      idleDelayMs: 100,
    }, { signal: abort.signal });
  });

  test("runDaemon exits on drain timeout", async () => {
    const { runDaemon } = await import("./worker");

    let discoverCalls = 0;

    const mockSql = createMockSql({
      // discoverEngineSchemas uses tagged template
      tagged: async () => {
        discoverCalls++;
        return [{ nspname: "me_test12345678" }];
      },
      // processBatch uses sql.begin()
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

    const start = Date.now();
    await runDaemon(mockSql as never, {
      embedding: {
        provider: "openai",
        model: "test",
        dimensions: 3,
      },
      idleDelayMs: 50,
      drainTimeoutMs: 100,
      refreshIntervalMs: 1_000_000, // don't refresh during test
    });

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(2000);
    expect(discoverCalls).toBeGreaterThanOrEqual(1);
  });
});
