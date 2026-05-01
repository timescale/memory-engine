/**
 * Tests for `me memory import` helpers.
 *
 * The skip-detection helper exists because `engine.memory.batchCreate`
 * silently drops conflicting ids (post-#64). Memory import — unlike pack
 * install — has no metadata to classify skips against, so this is just
 * a set difference between explicit-id requests and inserted ids.
 */
import { describe, expect, test } from "bun:test";
import { computeSkippedIds } from "./memory-import.ts";

describe("computeSkippedIds", () => {
  test("returns empty when every explicit id was inserted", () => {
    expect(computeSkippedIds(["a", "b", "c"], ["a", "b", "c"])).toEqual([]);
  });

  test("returns ids that are absent from inserted", () => {
    expect(computeSkippedIds(["a", "b", "c"], ["b"])).toEqual(["a", "c"]);
  });

  test("ignores extra inserted ids that weren't in the request", () => {
    // Auto-generated ids land in `insertedIds` but were never in
    // `explicitIds`, so they don't affect the skip count.
    expect(computeSkippedIds(["a"], ["a", "auto-1", "auto-2"])).toEqual([]);
  });

  test("handles mixed explicit + auto-generated requests", () => {
    // Caller submitted 2 explicit-id memories and 3 auto-id memories.
    // 1 explicit id collided; the other 4 inserts succeeded.
    const explicit = ["a", "b"];
    const inserted = ["b", "auto-1", "auto-2", "auto-3"];
    expect(computeSkippedIds(explicit, inserted)).toEqual(["a"]);
  });

  test("handles empty input", () => {
    expect(computeSkippedIds([], [])).toEqual([]);
    expect(computeSkippedIds([], ["auto-1"])).toEqual([]);
    expect(computeSkippedIds(["a"], [])).toEqual(["a"]);
  });

  test("preserves request order in the skipped list", () => {
    expect(computeSkippedIds(["c", "a", "b"], [])).toEqual(["c", "a", "b"]);
  });
});
