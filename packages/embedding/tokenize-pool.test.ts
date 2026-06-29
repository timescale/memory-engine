import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as WorkerThreads from "node:worker_threads";
import { isWithinTokenLimit } from "gpt-tokenizer/encoding/cl100k_base";
import {
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
