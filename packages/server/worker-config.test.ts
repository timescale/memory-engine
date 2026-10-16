import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startServer } from "./start";
import { buildWorkerSettings, resolveWorkerCount } from "./worker-config";
import { startEmbeddingWorkers } from "./worker-start";

const keys = [
  "WORKER_COUNT",
  "WORKER_BATCH_SIZE",
  "WORKER_DB_POOL_MAX",
  "EMBEDDING_API_KEY",
] as const;
let saved: (string | undefined)[];
beforeEach(() => {
  saved = keys.map((key) => process.env[key]);
  for (const key of keys) delete process.env[key];
});
afterEach(() => {
  keys.forEach((key, i) => {
    const value = saved[i];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
});

describe("worker configuration", () => {
  test("preaborted API and worker bootstraps reject before configuration or allocation", async () => {
    const controller = new AbortController();
    const reason = new Error("shutdown requested");
    controller.abort(reason);
    await expect(startServer({ signal: controller.signal })).rejects.toBe(
      reason,
    );
    await expect(
      startEmbeddingWorkers({ signal: controller.signal }),
    ).rejects.toBe(reason);
  });
  test("defaults to two, permits zero only for combined mode", () => {
    expect(resolveWorkerCount()).toBe(2);
    expect(resolveWorkerCount(0, true)).toBe(0);
    expect(() => resolveWorkerCount(0)).toThrow("positive integer");
  });
  test("rejects invalid explicit and environment counts", () => {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => resolveWorkerCount(value, true)).toThrow("integer");
    }
    for (const value of ["-1", "1.5", "2x", "NaN", "Infinity", " "]) {
      process.env.WORKER_COUNT = value;
      expect(() => resolveWorkerCount(undefined, true)).toThrow("integer");
    }
    process.env.WORKER_COUNT = "0";
    expect(resolveWorkerCount(undefined, true)).toBe(0);
    expect(() => resolveWorkerCount()).toThrow("positive");
    expect(resolveWorkerCount(3)).toBe(3);
  });
  test("preserves pool defaults and explicit option precedence", () => {
    const settings = buildWorkerSettings({
      workerCount: 3,
      workerIdleDelayMs: 17,
      workerRefreshIntervalMs: 25,
    });
    expect(settings.pool.max).toBe(3);
    expect(settings.config.idleDelayMs).toBe(17);
    expect(settings.config.refreshIntervalMs).toBe(25);
    expect(settings.config.batchSize).toBe(10);
    expect(settings.config.timeouts.statementTimeout).toBe("25s");
  });
  test("API-only skips worker-only parsing before building query embedding config", async () => {
    process.env.WORKER_BATCH_SIZE = "invalid";
    process.env.WORKER_DB_POOL_MAX = "invalid";
    const opts = {
      databaseUrl: "postgres://unused",
      apiBaseUrl: "http://localhost",
      migrate: false,
      workerCount: 0,
    };
    await expect(startServer(opts)).rejects.toThrow(
      "EMBEDDING_API_KEY is required",
    );
    await expect(startServer({ ...opts, workerCount: 1 })).rejects.toThrow(
      "WORKER_DB_POOL_MAX",
    );
  });
  test("standalone rejects zero without requiring API/auth settings or creating pools", async () => {
    await expect(startEmbeddingWorkers({ workerCount: 0 })).rejects.toThrow(
      "positive integer",
    );
  });
});
