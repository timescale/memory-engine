/**
 * Tests for the byte-aware chunker in `chunk.ts`.
 */
import { describe, expect, test } from "bun:test";
import type {
  MemoryCreateParams,
  MemoryWriteResult,
} from "@memory.build/protocol/memory";
import {
  approxMemoryBytes,
  type BatchCreateClient,
  batchCreateChunked,
  chunkByBytes,
} from "./chunk.ts";

describe("chunkByBytes", () => {
  // Cheap size: each character is 1 byte.
  const sizeAsLength = (s: string) => s.length;

  test("returns a single chunk when everything fits the budget", () => {
    const chunks = Array.from(
      chunkByBytes(["aa", "bb", "cc"], 100, 1000, sizeAsLength),
    );
    expect(chunks).toEqual([["aa", "bb", "cc"]]);
  });

  test("cuts a new chunk when adding the next item would overflow the byte budget", () => {
    const chunks = Array.from(
      chunkByBytes(["aaaa", "bbbb", "cccc"], 6, 1000, sizeAsLength),
    );
    // First two items: 4 + 4 = 8 > 6, so cut after 'aaaa'. Next: 4 + 4 = 8 > 6
    // again, cut after 'bbbb'. Then 'cccc' alone.
    expect(chunks).toEqual([["aaaa"], ["bbbb"], ["cccc"]]);
  });

  test("packs as many items as fit before cutting", () => {
    const chunks = Array.from(
      chunkByBytes(["aa", "bb", "cc", "dd"], 5, 1000, sizeAsLength),
    );
    // Running total: 2, 4 (still ≤5), 6 > 5 → cut. Next chunk starts at 'cc'.
    expect(chunks).toEqual([
      ["aa", "bb"],
      ["cc", "dd"],
    ]);
  });

  test("cuts a new chunk when count cap is hit before byte budget", () => {
    const chunks = Array.from(
      chunkByBytes(["a", "b", "c", "d", "e"], 999, 2, sizeAsLength),
    );
    expect(chunks).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  test("yields an oversized item alone instead of dropping it", () => {
    const big = "x".repeat(100);
    const chunks = Array.from(
      chunkByBytes(["aa", big, "bb"], 10, 1000, sizeAsLength),
    );
    // 'aa' fits, then 'big' would overflow → cut, big gets its own chunk
    // (even though it exceeds the budget on its own), then 'bb' starts a new chunk.
    expect(chunks).toEqual([["aa"], [big], ["bb"]]);
  });

  test("returns no chunks for empty input", () => {
    const chunks = Array.from(chunkByBytes([], 100, 1000, sizeAsLength));
    expect(chunks).toEqual([]);
  });
});

describe("approxMemoryBytes", () => {
  test("scales with content length", () => {
    const small = approxMemoryBytes({ content: "hi", tree: "t" });
    const large = approxMemoryBytes({
      content: "x".repeat(10_000),
      tree: "t",
    });
    expect(large).toBeGreaterThan(small + 9_000);
  });

  test("includes meta and id contribution", () => {
    const a = approxMemoryBytes({ content: "x", tree: "t" });
    const b = approxMemoryBytes({
      id: "00000000-0000-7000-8000-000000000001",
      content: "x",
      tree: "t",
      meta: { source_session_id: "abc", source_message_id: "def" },
    });
    expect(b).toBeGreaterThan(a);
  });

  test("counts UTF-8 bytes, not UTF-16 code units, for non-ASCII content", () => {
    // "abc" and "日本語" both have JS .length === 3, but the CJK string is
    // 9 UTF-8 bytes (3 bytes per char) — so the wire-size estimate must
    // differ. A String.length-based implementation would return identical
    // values here, missing roughly 6 bytes of real wire weight per CJK
    // memory and silently shrinking the headroom under the 1 MiB cap.
    const ascii = approxMemoryBytes({ content: "abc", tree: "t" });
    const cjk = approxMemoryBytes({ content: "日本語", tree: "t" });
    expect(cjk).toBeGreaterThan(ascii + 5);
  });
});

describe("batchCreateChunked", () => {
  /**
   * Build a tiny memory whose serialized size is just `bytes` of "x"
   * content. Lets each test control exactly how many chunks the byte
   * budget produces without depending on the 768 KiB default.
   */
  const mem = (id: string, contentBytes = 1): MemoryCreateParams => ({
    id,
    content: "x".repeat(contentBytes),
    tree: "t",
  });

  /** Minimal stub client; the test supplies the per-call behavior. */
  const stubClient = (
    handler: (
      memories: MemoryCreateParams[],
      onConflict?: "error" | "replace" | "ignore",
    ) => Promise<{ results: MemoryWriteResult[] }>,
  ): BatchCreateClient => ({
    memory: {
      batchCreate: ({ memories, onConflict }) => handler(memories, onConflict),
    },
  });

  /** Build inserted results for a chunk, keyed on each memory's id. */
  const inserted = (memories: MemoryCreateParams[]): MemoryWriteResult[] =>
    memories.map((m) => ({ id: m.id ?? "auto", status: "inserted" as const }));

  test("single chunk, all succeed", async () => {
    const calls: number[] = [];
    const client = stubClient(async (memories) => {
      calls.push(memories.length);
      return { results: inserted(memories) };
    });
    const result = await batchCreateChunked(client, [mem("a"), mem("b")]);
    expect(result.results).toEqual([
      { id: "a", status: "inserted" },
      { id: "b", status: "inserted" },
    ]);
    expect(result.errors).toEqual([]);
    expect(calls).toEqual([2]); // single batchCreate call
  });

  test("two chunks succeed, results accumulate across chunks in order", async () => {
    // Force two chunks via big content (the 768 KiB default isn't overridable
    // through the public API). We assert results accumulate, not boundaries.
    const big = mem("big", 700_000);
    const small = mem("small", 10);
    const client = stubClient(async (memories) => ({
      results: inserted(memories),
    }));
    const result = await batchCreateChunked(client, [big, small]);
    expect(result.results.map((r) => r.id).sort()).toEqual(["big", "small"]);
    expect(result.results.every((r) => r.status === "inserted")).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("second chunk fails: first inserted, second is an 'error' row", async () => {
    const big1 = mem("a", 700_000);
    const big2 = mem("b", 700_000);
    let call = 0;
    const client = stubClient(async (memories) => {
      call++;
      if (call === 2) throw new Error("server boom");
      return { results: inserted(memories) };
    });
    const result = await batchCreateChunked(client, [big1, big2]);
    // One row per input, in order: a inserted, b's chunk failed → 'error'.
    expect(result.results).toEqual([
      { id: "a", status: "inserted" },
      { id: "b", status: "error" },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      chunkIndex: 1,
      itemCount: 1,
      ids: ["b"],
      error: "server boom",
    });
  });

  test("all chunks fail: every input is an 'error' row", async () => {
    const big1 = mem("a", 700_000);
    const big2 = mem("b", 700_000);
    const client = stubClient(async () => {
      throw new Error("network down");
    });
    const result = await batchCreateChunked(client, [big1, big2]);
    expect(result.results).toEqual([
      { id: "a", status: "error" },
      { id: "b", status: "error" },
    ]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]?.chunkIndex).toBe(0);
    expect(result.errors[1]?.chunkIndex).toBe(1);
  });

  test("a failed input with no explicit id gets a null id 'error' row", async () => {
    const noId: MemoryCreateParams = { content: "x", tree: "t" };
    const client = stubClient(async () => {
      throw new Error("boom");
    });
    const result = await batchCreateChunked(client, [noId]);
    expect(result.results).toEqual([{ id: null, status: "error" }]);
    expect(result.errors[0]?.ids).toEqual([]); // no explicit id to report
  });

  test("carries per-row status (inserted/skipped) through unchanged", async () => {
    // Caller submits 3 memories; the server skips one (its idempotency key
    // already existed). The helper faithfully reports each row's status in
    // submission order — classifying the skip is the caller's job.
    const client = stubClient(async (memories) => ({
      results: memories.map((m) => ({
        id: m.id ?? "auto",
        status: m.id === "dup" ? ("skipped" as const) : ("inserted" as const),
      })),
    }));
    const result = await batchCreateChunked(client, [
      mem("a"),
      mem("dup"),
      mem("b"),
    ]);
    expect(result.results).toEqual([
      { id: "a", status: "inserted" },
      { id: "dup", status: "skipped" },
      { id: "b", status: "inserted" },
    ]);
    expect(result.errors).toEqual([]); // no chunk failed
  });

  test("passes onConflict through every chunk and accumulates updated rows", async () => {
    // Two chunks (big payloads); the server reports the first row of each
    // chunk as updated and the rest as inserted.
    const seen: Array<string | undefined> = [];
    const client = stubClient(async (memories, onConflict) => {
      seen.push(onConflict);
      return {
        results: memories.map((m, i) => ({
          id: m.id ?? "auto",
          status: i === 0 ? ("updated" as const) : ("inserted" as const),
        })),
      };
    });
    const result = await batchCreateChunked(
      client,
      [mem("a", 700_000), mem("b", 10), mem("c", 700_000), mem("d", 10)],
      { onConflict: "replace" },
    );
    expect(seen.length).toBeGreaterThan(1); // multiple chunks
    expect(new Set(seen)).toEqual(new Set(["replace"]));
    const updated = result.results.filter((r) => r.status === "updated");
    expect(updated.length).toBe(seen.length); // one updated per chunk
    expect(result.results.map((r) => r.id).sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  test("leaves onConflict unset when no option is given", async () => {
    let seen: string | undefined = "sentinel";
    const client: BatchCreateClient = {
      memory: {
        batchCreate: async ({ memories, onConflict }) => {
          seen = onConflict;
          return { results: inserted(memories) };
        },
      },
    };
    await batchCreateChunked(client, [mem("a")]);
    expect(seen).toBeUndefined();
  });

  test("empty input never calls the server", async () => {
    let calls = 0;
    const client = stubClient(async () => {
      calls++;
      return { results: [] };
    });
    const result = await batchCreateChunked(client, []);
    expect(result.results).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(calls).toBe(0);
  });
});
