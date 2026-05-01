/**
 * Tests for the byte-aware chunker in `chunk.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { MemoryCreateParams } from "@memory.build/protocol/engine";
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
    handler: (memories: MemoryCreateParams[]) => Promise<{ ids: string[] }>,
  ): BatchCreateClient => ({
    memory: { batchCreate: ({ memories }) => handler(memories) },
  });

  test("single chunk, all succeed", async () => {
    const calls: number[] = [];
    const client = stubClient(async (memories) => {
      calls.push(memories.length);
      return { ids: memories.map((m) => m.id ?? "auto") };
    });
    const result = await batchCreateChunked(client, [mem("a"), mem("b")]);
    expect(result.insertedIds).toEqual(["a", "b"]);
    expect(result.failedIds).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(calls).toEqual([2]); // single batchCreate call
  });

  test("two chunks succeed, insertedIds accumulate across chunks", async () => {
    // Force two chunks via a tight byte budget by using big content. We
    // can't override the 768 KiB default through the public API, so use
    // many small memories and rely on the count cap... actually easier:
    // use one big enough that two would overflow.
    const big = mem("big", 700_000);
    const small = mem("small", 10);
    const client = stubClient(async (memories) => ({
      ids: memories.map((m) => m.id ?? "auto"),
    }));
    const result = await batchCreateChunked(client, [big, small]);
    // Both items land; we don't assert chunk boundaries here, only that
    // ids are accumulated correctly across however many chunks fired.
    expect(result.insertedIds.sort()).toEqual(["big", "small"]);
    expect(result.failedIds).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("second chunk fails: insertedIds from first only, failedIds from second", async () => {
    const big1 = mem("a", 700_000);
    const big2 = mem("b", 700_000);
    let call = 0;
    const client = stubClient(async (memories) => {
      call++;
      if (call === 2) throw new Error("server boom");
      return { ids: memories.map((m) => m.id ?? "auto") };
    });
    const result = await batchCreateChunked(client, [big1, big2]);
    expect(result.insertedIds).toEqual(["a"]);
    expect(result.failedIds).toEqual(["b"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      chunkIndex: 1,
      itemCount: 1,
      ids: ["b"],
      error: "server boom",
    });
  });

  test("all chunks fail: insertedIds empty, failedIds covers all explicit ids", async () => {
    const big1 = mem("a", 700_000);
    const big2 = mem("b", 700_000);
    const client = stubClient(async () => {
      throw new Error("network down");
    });
    const result = await batchCreateChunked(client, [big1, big2]);
    expect(result.insertedIds).toEqual([]);
    expect(result.failedIds.sort()).toEqual(["a", "b"]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]?.chunkIndex).toBe(0);
    expect(result.errors[1]?.chunkIndex).toBe(1);
  });

  test("server returns shorter ids than requested (simulating ON CONFLICT)", async () => {
    // Mimics post-#64 server behavior: caller submits 3 memories, server
    // inserts 2 (one was a duplicate id, dropped by ON CONFLICT). The
    // helper should faithfully report the 2 inserted; classifying the
    // missing one as "skipped" is the caller's job.
    const client = stubClient(async (memories) => ({
      ids: memories.map((m) => m.id ?? "auto").filter((id) => id !== "dup"), // server "drops" the dup id
    }));
    const result = await batchCreateChunked(client, [
      mem("a"),
      mem("dup"),
      mem("b"),
    ]);
    expect(result.insertedIds).toEqual(["a", "b"]);
    expect(result.failedIds).toEqual([]); // no chunk failed
    expect(result.errors).toEqual([]);
  });

  test("empty input never calls the server", async () => {
    let calls = 0;
    const client = stubClient(async () => {
      calls++;
      return { ids: [] };
    });
    const result = await batchCreateChunked(client, []);
    expect(result.insertedIds).toEqual([]);
    expect(result.failedIds).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(calls).toBe(0);
  });
});
