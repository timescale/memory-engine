import { expect, test } from "bun:test";

// Isolate module mocks in a child: the regular test suite also imports these
// modules for real. No database, credentials, or embedding API calls.
const setup = `
import { mock } from "bun:test";
const pools = [];
let discoverCalls = 0;
let failAt = Infinity;
let discoveryHook = async () => {};
let closeError;
mock.module("postgres", () => ({ default: (url) => {
  const pool = { url, closes: 0, end: async () => { pool.closes++; if (closeError) throw closeError; } };
  pools.push(pool);
  return pool;
}}));
mock.module("@memory.build/engine/core", () => ({ coreStore: () => ({
  listSpaces: async () => {
    if (++discoverCalls >= failAt) throw new Error("discovery failed");
    await discoveryHook();
    return [];
  }
}) }));
const { startEmbeddingWorkers, startWorkerPool } = await import("./packages/server/worker-start.ts");
const { buildWorkerSettings } = await import("./packages/server/worker-config.ts");
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

test("preaborted startup creates no pools or discovery and preserves reason", async () => {
  await isolated(`
    const controller = new AbortController();
    const reason = new Error("cancelled"); controller.abort(reason);
    for (const start of [
      () => startEmbeddingWorkers({ ...opts, signal: controller.signal }),
      () => startWorkerPool(opts.databaseUrl, opts.embeddingConfig, async () => { discoverCalls++; return []; }, buildWorkerSettings(opts), 1, controller.signal)
    ]) {
      try { await start(); throw new Error("unexpected success"); }
      catch (error) { check(error === reason, "exact abort reason"); }
    }
    check(pools.length === 0 && discoverCalls === 0, "no allocation/discovery");
  `);
});

test("abort immediately after starting skips deferred discovery and drains partial startup", async () => {
  await isolated(`
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const startup = startWorkerPool(opts.databaseUrl, opts.embeddingConfig, async () => {
      discoverCalls++; return [];
    }, buildWorkerSettings(opts), 3, controller.signal);
    controller.abort(reason);
    try { await startup; throw new Error("unexpected success"); }
    catch (error) { check(error === reason, "exact cancellation reason"); }
    check(discoverCalls === 0, "queued discovery skipped");
    check(pools.every(p => p.closes === 1), "partial startup drained once");
  `);
});

test("pool abort listener is removed on failure and shared stop", async () => {
  await isolated(`
    for (const fail of [false, true]) {
      const controller = new AbortController();
      const signal = controller.signal;
      let listeners = 0;
      const add = signal.addEventListener.bind(signal);
      const remove = signal.removeEventListener.bind(signal);
      signal.addEventListener = (...args) => { if (args[0] === "abort") listeners++; return add(...args); };
      signal.removeEventListener = (...args) => { if (args[0] === "abort") listeners--; return remove(...args); };
      const settings = buildWorkerSettings(opts);
      let workers;
      try {
        workers = await startWorkerPool(opts.databaseUrl, opts.embeddingConfig, async () => {
          check(listeners === 1, "listener installed before discovery");
          if (fail) throw new Error("discovery failed");
          return [];
        }, settings, 1, signal);
      } catch (error) { check(fail && error.message === "discovery failed", "real failure"); }
      if (workers) {
        check(listeners === 1, "listener remains while running");
        const a = workers.stop(), b = workers.stop();
        check(a === b, "shared stop"); await a;
      }
      check(listeners === 0, "no remaining listener");
      controller.abort();
    }
    check(pools.every(p => p.closes === 1), "closed once");
  `);
});

test("abort after pool startup closes once and shares the later explicit stop", async () => {
  await isolated(`
    const controller = new AbortController();
    const workers = await startWorkerPool(opts.databaseUrl, opts.embeddingConfig, async () => [], buildWorkerSettings(opts), 1, controller.signal);
    controller.abort();
    const a = workers.stop(), b = workers.stop();
    check(a === b, "abort and explicit stop share drain");
    await a;
    check(pools.every(p => p.closes === 1), "closed exactly once");
  `);
});

test("abort during discovery waits cleanup and rejects exact reason without further discovery", async () => {
  await isolated(`
    const controller = new AbortController();
    const reason = new Error("cancelled");
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    discoveryHook = async () => { controller.abort(reason); await gate; };
    let settled = false;
    const startup = startEmbeddingWorkers({ ...opts, workerCount: 3, signal: controller.signal });
    void startup.then(() => { settled = true; }, () => { settled = true; });
    await Bun.sleep(5);
    check(!settled && pools.every(p => p.closes === 0), "drain waits discovery");
    release();
    try { await startup; throw new Error("unexpected success"); }
    catch (error) { check(error === reason, "exact abort reason"); }
    check(discoverCalls === 1, "no later worker discovery");
    check(pools.every(p => p.closes === 1), "all cleanup awaited");
  `);
});

test("cleanup failure during cancellation is not mistaken for expected shutdown", async () => {
  await isolated(`
    const controller = new AbortController();
    const reason = new Error("cancelled");
    closeError = new Error("database close failed");
    try {
      await startWorkerPool(opts.databaseUrl, opts.embeddingConfig, async () => {
        controller.abort(reason); return [];
      }, buildWorkerSettings(opts), 1, controller.signal);
      throw new Error("unexpected success");
    } catch (error) { check(error === closeError, "cleanup failure wins cancellation"); }
    check(pools.every(p => p.closes === 1), "close attempted exactly once");
  `);
});

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
