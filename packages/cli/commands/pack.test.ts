/**
 * Tests for `me pack` helpers.
 *
 * The skip-classification helper exists because `engine.memory.batchCreate`
 * silently drops conflicting ids (post-#64) — pack install needs to tell
 * benign re-installs (already at this version) from suspicious id collisions
 * (some other pack or a non-pack memory holds the id).
 */
import { describe, expect, test } from "bun:test";
import { classifySkips } from "./pack.ts";

describe("classifySkips", () => {
  test("returns empty buckets when every requested id was inserted", () => {
    const result = classifySkips({
      requestedIds: ["a", "b", "c"],
      insertedIds: ["a", "b", "c"],
      existing: [],
      packName: "foo",
      packVersion: "1",
    });
    expect(result.idempotent).toEqual([]);
    expect(result.conflict).toEqual([]);
  });

  test("classifies a skipped id as idempotent when same pack+version is present", () => {
    const result = classifySkips({
      requestedIds: ["a", "b"],
      insertedIds: ["b"],
      existing: [{ id: "a", meta: { pack: { name: "foo", version: "1" } } }],
      packName: "foo",
      packVersion: "1",
    });
    expect(result.idempotent).toEqual(["a"]);
    expect(result.conflict).toEqual([]);
  });

  test("classifies a skipped id as conflict when no existing row matches", () => {
    // batchCreate skipped "a" but the step-3 search didn't find it tagged
    // with this pack — so something else (a non-pack memory) holds the id.
    const result = classifySkips({
      requestedIds: ["a", "b"],
      insertedIds: ["b"],
      existing: [],
      packName: "foo",
      packVersion: "1",
    });
    expect(result.idempotent).toEqual([]);
    expect(result.conflict).toEqual(["a"]);
  });

  test("classifies as conflict when the existing row belongs to a different pack", () => {
    const result = classifySkips({
      requestedIds: ["a"],
      insertedIds: [],
      existing: [{ id: "a", meta: { pack: { name: "other", version: "1" } } }],
      packName: "foo",
      packVersion: "1",
    });
    expect(result.idempotent).toEqual([]);
    expect(result.conflict).toEqual(["a"]);
  });

  test("classifies as conflict when version differs (caller bug — stale should have been deleted)", () => {
    const result = classifySkips({
      requestedIds: ["a"],
      insertedIds: [],
      existing: [{ id: "a", meta: { pack: { name: "foo", version: "0" } } }],
      packName: "foo",
      packVersion: "1",
    });
    expect(result.idempotent).toEqual([]);
    expect(result.conflict).toEqual(["a"]);
  });

  test("separates idempotent from conflict in a mixed batch", () => {
    const result = classifySkips({
      requestedIds: ["a", "b", "c", "d"],
      insertedIds: ["b"],
      existing: [
        { id: "a", meta: { pack: { name: "foo", version: "1" } } }, // idempotent
        { id: "c", meta: { pack: { name: "other", version: "1" } } }, // conflict (other pack)
        { id: "d", meta: {} }, // conflict (non-pack memory)
      ],
      packName: "foo",
      packVersion: "1",
    });
    expect(result.idempotent).toEqual(["a"]);
    expect(result.conflict).toEqual(["c", "d"]);
  });

  test("treats malformed meta defensively as a conflict", () => {
    const result = classifySkips({
      requestedIds: ["a", "b", "c"],
      insertedIds: [],
      existing: [
        { id: "a", meta: undefined },
        { id: "b", meta: { pack: "not-an-object" } },
        { id: "c", meta: { pack: { name: "foo" } } }, // version missing
      ],
      packName: "foo",
      packVersion: "1",
    });
    expect(result.idempotent).toEqual([]);
    expect(result.conflict).toEqual(["a", "b", "c"]);
  });

  test("preserves request order in the classification arrays", () => {
    const result = classifySkips({
      requestedIds: ["c", "a", "b"],
      insertedIds: [],
      existing: [
        { id: "a", meta: { pack: { name: "foo", version: "1" } } },
        { id: "b", meta: { pack: { name: "foo", version: "1" } } },
        { id: "c", meta: { pack: { name: "foo", version: "1" } } },
      ],
      packName: "foo",
      packVersion: "1",
    });
    expect(result.idempotent).toEqual(["c", "a", "b"]);
    expect(result.conflict).toEqual([]);
  });

  test("ignores existing rows whose ids weren't requested", () => {
    // The step-3 search may return rows that aren't in the new pack
    // (e.g. memories removed in a version bump, before step-6 deletion
    // runs). Those should not count toward classification.
    const result = classifySkips({
      requestedIds: ["a"],
      insertedIds: ["a"],
      existing: [
        { id: "a", meta: { pack: { name: "foo", version: "1" } } },
        { id: "removed", meta: { pack: { name: "foo", version: "1" } } },
      ],
      packName: "foo",
      packVersion: "1",
    });
    expect(result.idempotent).toEqual([]);
    expect(result.conflict).toEqual([]);
  });
});
