import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as WorkerThreads from "node:worker_threads";
import { isWithinTokenLimit } from "gpt-tokenizer/encoding/cl100k_base";
import {
  getTokenizerPoolStats,
  getTokenizerThreadCount,
  shutdownTokenizerPool,
  truncateTextsToTokenLimit,
} from "./tokenize-pool";
import { truncateToTokenLimit } from "./truncate";

const originalThreadCount = process.env.EMBEDDING_TOKENIZE_THREADS;

afterEach(async () => {
  if (originalThreadCount === undefined) {
    delete process.env.EMBEDDING_TOKENIZE_THREADS;
  } else {
    process.env.EMBEDDING_TOKENIZE_THREADS = originalThreadCount;
  }
  await shutdownTokenizerPool();
});

describe("getTokenizerThreadCount", () => {
  test("auto-sizes to at least one and at most four threads", () => {
    delete process.env.EMBEDDING_TOKENIZE_THREADS;

    const count = getTokenizerThreadCount();

    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(4);
  });

  test("allows inline mode", () => {
    process.env.EMBEDDING_TOKENIZE_THREADS = "0";

    expect(getTokenizerThreadCount()).toBe(0);
  });

  test("rejects invalid values", () => {
    process.env.EMBEDDING_TOKENIZE_THREADS = "nope";

    expect(() => getTokenizerThreadCount()).toThrow(
      "EMBEDDING_TOKENIZE_THREADS must be a non-negative integer",
    );
  });

  test("rejects non-integer values rather than silently truncating", () => {
    for (const raw of ["1.5", "2abc", "-1"]) {
      process.env.EMBEDDING_TOKENIZE_THREADS = raw;
      expect(() => getTokenizerThreadCount()).toThrow(
        "EMBEDDING_TOKENIZE_THREADS must be a non-negative integer",
      );
    }
  });
});

const idleStats = {
  threads: 0,
  activeJobs: 0,
  queuedJobs: 0,
  activeInputBytes: 0,
  queuedInputBytes: 0,
};

/** Controllable worker without module mocks, real threads, timers, or network. */
class FakeWorker extends EventEmitter {
  request?: { id: number; texts: string[]; maxTokens: number };
  failSend = false;
  terminated = false;

  unref() {}

  postMessage(request: NonNullable<FakeWorker["request"]>) {
    if (this.failSend) throw new Error("send failed");
    this.request = request;
  }

  async terminate() {
    this.terminated = true;
    return 0;
  }

  complete() {
    const request = this.request;
    if (!request) throw new Error("No request");
    this.request = undefined;
    this.emit("message", {
      id: request.id,
      results: request.texts.map((text) =>
        truncateToTokenLimit(text, request.maxTokens),
      ),
    });
  }
}

async function withFakeWorkers(
  callback: (workers: FakeWorker[]) => Promise<void>,
): Promise<void> {
  process.env.EMBEDDING_TOKENIZE_THREADS = "1";
  const workers: FakeWorker[] = [];
  const spawnSpy = spyOn(WorkerThreads, "Worker").mockImplementation((() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }) as never);
  try {
    await callback(workers);
  } finally {
    await shutdownTokenizerPool();
    spawnSpy.mockRestore();
  }
}

describe("getTokenizerPoolStats", () => {
  test("does not create a pool or parse configuration when sampled", () => {
    process.env.EMBEDDING_TOKENIZE_THREADS = "invalid";
    expect(getTokenizerPoolStats()).toEqual(idleStats);
    const snapshot = getTokenizerPoolStats();
    snapshot.threads = 99;
    expect(getTokenizerPoolStats()).toEqual(idleStats);
  });

  test("inline mode has no live workers or tracked inputs", async () => {
    process.env.EMBEDDING_TOKENIZE_THREADS = "0";
    await truncateTextsToTokenLimit(["あ🙂"], 100);
    expect(getTokenizerPoolStats()).toEqual(idleStats);
  });

  test("separates queued and active UTF-8 bytes and clears completed jobs", async () => {
    await withFakeWorkers(async (workers) => {
      const first = truncateTextsToTokenLimit(["あ🙂", "a"], 100);
      const second = truncateTextsToTokenLimit(["é", "中"], 100);
      const third = truncateTextsToTokenLimit([""], 100);
      expect(getTokenizerPoolStats()).toEqual({
        threads: 1,
        activeJobs: 1,
        queuedJobs: 2,
        activeInputBytes: 8,
        queuedInputBytes: 5,
      });
      workers[0]?.complete();
      expect(getTokenizerPoolStats()).toEqual({
        threads: 1,
        activeJobs: 1,
        queuedJobs: 1,
        activeInputBytes: 5,
        queuedInputBytes: 0,
      });
      workers[0]?.complete();
      expect(getTokenizerPoolStats().activeJobs).toBe(1);
      expect(getTokenizerPoolStats().activeInputBytes).toBe(0);
      workers[0]?.complete();
      await Promise.all([first, second, third]);
      expect(getTokenizerPoolStats()).toEqual({ ...idleStats, threads: 1 });
    });
  });

  test("clears protocol and job failures, ignoring late responses", async () => {
    await withFakeWorkers(async (workers) => {
      const first = truncateTextsToTokenLimit(["あ"], 100);
      const second = truncateTextsToTokenLimit(["é"], 100);
      const worker = workers[0];
      const firstId = worker?.request?.id;
      worker?.emit("message", { id: firstId, error: "failed" });
      expect(getTokenizerPoolStats().activeInputBytes).toBe(2);
      worker?.emit("message", { id: firstId, results: [] });
      expect(getTokenizerPoolStats().activeInputBytes).toBe(2);
      worker?.emit("message", { id: worker.request?.id, results: [] });
      expect(await first).toEqual([truncateToTokenLimit("あ", 100)]);
      expect(await second).toEqual([truncateToTokenLimit("é", 100)]);
      expect(getTokenizerPoolStats()).toEqual({ ...idleStats, threads: 1 });
    });
  });

  for (const failure of ["error", "exit", "postMessage"] as const) {
    test(`cleans active bytes on ${failure} failure and replaces worker`, async () => {
      await withFakeWorkers(async (workers) => {
        const first = truncateTextsToTokenLimit(["あ"], 100);
        const second = truncateTextsToTokenLimit(["é"], 100);
        const worker = workers[0];
        if (failure === "postMessage") {
          if (worker) worker.failSend = true;
          worker?.complete();
        } else if (failure === "error") {
          worker?.emit("error", new Error("failed"));
          // A stale exit after replacement must not subtract twice.
          worker?.emit("exit", 1);
        } else {
          worker?.emit("exit", 0);
        }
        expect(workers).toHaveLength(2);
        expect(getTokenizerPoolStats()).toEqual({
          threads: 1,
          activeJobs: failure === "postMessage" ? 0 : 1,
          queuedJobs: 0,
          activeInputBytes: failure === "postMessage" ? 0 : 2,
          queuedInputBytes: 0,
        });
        if (failure !== "postMessage") workers[1]?.complete();
        await Promise.all([first, second]);
        expect(getTokenizerPoolStats()).toEqual({ ...idleStats, threads: 1 });
        expect(worker?.terminated).toBe(true);
      });
    });
  }

  test("shutdown clears queued and active jobs before termination finishes", async () => {
    await withFakeWorkers(async () => {
      const first = truncateTextsToTokenLimit(["あ"], 100);
      const second = truncateTextsToTokenLimit(["é"], 100);
      const shutdown = shutdownTokenizerPool();
      expect(getTokenizerPoolStats()).toEqual(idleStats);
      await shutdown;
      expect(await first).toEqual([truncateToTokenLimit("あ", 100)]);
      expect(await second).toEqual([truncateToTokenLimit("é", 100)]);
      expect(getTokenizerPoolStats()).toEqual(idleStats);
    });
  });

  test("spawn failure leaves no pool or bytes", async () => {
    process.env.EMBEDDING_TOKENIZE_THREADS = "2";
    const worker = new FakeWorker();
    let spawns = 0;
    const spawnSpy = spyOn(WorkerThreads, "Worker").mockImplementation((() => {
      if (spawns++ === 0) return worker;
      throw new Error("spawn failed");
    }) as never);
    try {
      await truncateTextsToTokenLimit(["あ"], 100);
      expect(getTokenizerPoolStats()).toEqual(idleStats);
      expect(worker.terminated).toBe(true);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("failed replacement rejects queue for inline fallback and permits rebuilding", async () => {
    process.env.EMBEDDING_TOKENIZE_THREADS = "1";
    const worker = new FakeWorker();
    let spawns = 0;
    const spawnSpy = spyOn(WorkerThreads, "Worker").mockImplementation((() => {
      if (spawns++ === 0) return worker;
      throw new Error("spawn failed");
    }) as never);
    try {
      const first = truncateTextsToTokenLimit(["あ"], 100);
      const second = truncateTextsToTokenLimit(["é"], 100);
      worker.emit("error", new Error("failed"));
      await Promise.all([first, second]);
      expect(getTokenizerPoolStats()).toEqual(idleStats);
    } finally {
      spawnSpy.mockRestore();
    }
    await truncateTextsToTokenLimit(["rebuilt"], 100);
    expect(getTokenizerPoolStats()).toEqual({ ...idleStats, threads: 1 });
  });
});

describe("truncateTextsToTokenLimit", () => {
  test("uses inline truncation when thread count is zero", async () => {
    process.env.EMBEDDING_TOKENIZE_THREADS = "0";
    const texts = ["short", "あ".repeat(5000)];

    const results = await truncateTextsToTokenLimit(texts, 100);

    expect(results).toEqual(
      texts.map((text) => truncateToTokenLimit(text, 100)),
    );
  });

  test("truncates in a worker thread", async () => {
    process.env.EMBEDDING_TOKENIZE_THREADS = "1";
    const dense = "あ".repeat(5000);

    const [result] = await truncateTextsToTokenLimit([dense], 100);

    expect(result?.truncated).toBe(true);
    expect(result?.text).toBe(truncateToTokenLimit(dense, 100).text);
    expect(isWithinTokenLimit(result?.text ?? "", 100)).not.toBe(false);
  });

  test("handles concurrent batches", async () => {
    process.env.EMBEDDING_TOKENIZE_THREADS = "2";
    const texts = ["first ".repeat(1000), "second ".repeat(1000)];

    const [first, second] = await Promise.all([
      truncateTextsToTokenLimit([texts[0] ?? ""], 50),
      truncateTextsToTokenLimit([texts[1] ?? ""], 60),
    ]);

    expect(first[0]?.text).toBe(truncateToTokenLimit(texts[0] ?? "", 50).text);
    expect(second[0]?.text).toBe(truncateToTokenLimit(texts[1] ?? "", 60).text);
  });

  test("returns an empty array for empty input", async () => {
    process.env.EMBEDDING_TOKENIZE_THREADS = "1";

    expect(await truncateTextsToTokenLimit([], 100)).toEqual([]);
  });

  test("falls back to inline truncation when a worker cannot spawn", async () => {
    // Force the pool down a path where worker construction throws (the worker
    // entry URL can't resolve), so it must degrade to inline truncation rather
    // than fail the embedding.
    process.env.EMBEDDING_TOKENIZE_THREADS = "1";
    const spawnSpy = spyOn(WorkerThreads, "Worker").mockImplementation((() => {
      throw new Error("spawn failed");
    }) as never);

    try {
      const dense = "あ".repeat(5000);
      const [result] = await truncateTextsToTokenLimit([dense], 100);

      expect(result?.text).toBe(truncateToTokenLimit(dense, 100).text);
      expect(result?.truncated).toBe(true);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("rebuilds a working pool after shutdown", async () => {
    process.env.EMBEDDING_TOKENIZE_THREADS = "1";

    // Prime a real pool, then shut it down. The singleton resets, so a
    // subsequent call must transparently rebuild and keep truncating.
    await truncateTextsToTokenLimit(["warm up"], 100);
    await shutdownTokenizerPool();

    const dense = "あ".repeat(5000);
    const [result] = await truncateTextsToTokenLimit([dense], 100);

    expect(result?.text).toBe(truncateToTokenLimit(dense, 100).text);
  });
});
