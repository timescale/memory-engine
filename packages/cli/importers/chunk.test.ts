/**
 * Tests for the byte-aware chunker in `chunk.ts`.
 */
import { describe, expect, test } from "bun:test";
import { approxMemoryBytes, chunkByBytes } from "./chunk.ts";

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
});
