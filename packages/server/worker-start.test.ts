import { expect, test } from "bun:test";

// Isolate module mocks in a child: the regular test suite also imports these
// modules for real. No database, credentials, or embedding API calls.
const setup = `
import { mock } from "bun:test";
const pools = [];
let discoverCalls = 0;
let failAt = Infinity;
mock.module("postgres", () => ({ default: (url) => {
  const pool = { url, closes: 0, end: async () => { pool.closes++; } };
  pools.push(pool);
  return pool;
}}));
mock.module("@memory.build/engine/core", () => ({ coreStore: () => ({
  listSpaces: async () => {
    if (++discoverCalls >= failAt) throw new Error("discovery failed");
    return [];
  }
}) }));
const { startEmbeddingWorkers } = await import("./packages/server/worker-start.ts");
const opts = {
  databaseUrl: "postgres://discovery", workerDatabaseUrl: "postgres://queue",
  workerCount: 1, workerIdleDelayMs: 1,
  embeddingConfig: { provider: "openai", model: "test", dimensions: 3 }
};
function check(value, message) { if (!value) throw new Error(message); }
`;

async function isolated(body: string) {
  const result = Bun.spawn(["./bun", "-e", setup + body], {
    cwd: new URL("../..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    result.exited,
    new Response(result.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
}

test("standalone startup discovery failure closes both pools", async () => {
  await isolated(`
    failAt = 1;
    try { await startEmbeddingWorkers(opts); throw new Error("expected failure"); }
    catch (error) { check(error.message === "discovery failed", error.message); }
    check(pools.length === 2, "two pools created");
    check(pools.every(p => p.closes === 1), "all pools closed");
  `);
});

test("standalone separates discovery and queue URLs; stop is shared and idempotent", async () => {
  await isolated(`
    const workers = await startEmbeddingWorkers(opts);
    check(discoverCalls === 1, "startup validates discovery");
    check(pools[0].url === opts.databaseUrl, "discovery URL");
    check(pools[1].url === opts.workerDatabaseUrl, "queue URL");
    check(workers.stats.totalProcessed === 0, "initial stats");
    const a = workers.stop(); const b = workers.stop();
    check(a === b, "shared shutdown promise");
    await Promise.all([a,b]);
    check(pools.every(p => p.closes === 1), "all pools closed once");
  `);
});

test("fatal discovery refresh is observable and shutdown still closes both pools", async () => {
  await isolated(`
    failAt = 2;
    const workers = await startEmbeddingWorkers({ ...opts, workerRefreshIntervalMs: 0 });
    try { await workers.finished; throw new Error("expected loop failure"); }
    catch (error) { check(error.message === "discovery failed", error.message); }
    try { await workers.stop(); } catch {}
    check(pools.every(p => p.closes === 1), "all pools closed after fatal failure");
  `);
});
