/**
 * Tests for `me pack` helpers.
 *
 * The skip-classification helper exists because `engine.memory.batchCreate`
 * reports a row whose deterministic id already existed as `status: 'skipped'`
 * — pack install needs to tell benign re-installs (already at this version)
 * from suspicious id collisions (some other pack or a non-pack memory holds the
 * id). The caller passes the already-known skipped ids (filtered from the
 * per-row write results); a failed-chunk row never reaches `results`, so it
 * can't be mis-classified here.
 */
import { describe, expect, test } from "bun:test";
import { classifySkips } from "./pack.ts";

describe("classifySkips", () => {
  test("returns empty buckets when nothing was skipped", () => {
    const result = classifySkips({
      skippedIds: [],
      existing: [],
      packName: "foo",
      packVersion: "1",
    });
    expect(result.idempotent).toEqual([]);
    expect(result.conflict).toEqual([]);
  });

  test("classifies a skipped id as idempotent when same pack+version is present", () => {
    const result = classifySkips({
      skippedIds: ["a"],
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
      skippedIds: ["a"],
      existing: [],
      packName: "foo",
      packVersion: "1",
    });
    expect(result.idempotent).toEqual([]);
    expect(result.conflict).toEqual(["a"]);
  });

  test("classifies as conflict when the existing row belongs to a different pack", () => {
    const result = classifySkips({
      skippedIds: ["a"],
      existing: [{ id: "a", meta: { pack: { name: "other", version: "1" } } }],
      packName: "foo",
      packVersion: "1",
    });
    expect(result.idempotent).toEqual([]);
    expect(result.conflict).toEqual(["a"]);
  });

  test("classifies as conflict when version differs (caller bug — stale should have been deleted)", () => {
    const result = classifySkips({
      skippedIds: ["a"],
      existing: [{ id: "a", meta: { pack: { name: "foo", version: "0" } } }],
      packName: "foo",
      packVersion: "1",
    });
    expect(result.idempotent).toEqual([]);
    expect(result.conflict).toEqual(["a"]);
  });

  test("separates idempotent from conflict in a mixed skip set", () => {
    const result = classifySkips({
      skippedIds: ["a", "c", "d"],
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
      skippedIds: ["a", "b", "c"],
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

  test("preserves skip order in the classification arrays", () => {
    const result = classifySkips({
      skippedIds: ["c", "a", "b"],
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

  test("ignores existing rows whose ids weren't skipped", () => {
    // The step-3 search may return rows that aren't in the new pack
    // (e.g. memories removed in a version bump, before step-6 deletion
    // runs). With nothing skipped, those extra existing rows are ignored.
    const result = classifySkips({
      skippedIds: [],
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
