/**
 * Tests for importer helpers in `index.ts`.
 */
import { describe, expect, test } from "bun:test";
import { dedupByMemoryId } from "./index.ts";

describe("dedupByMemoryId", () => {
  test("returns input unchanged when all ids are unique", () => {
    const items = [
      { memoryId: "a", value: 1 },
      { memoryId: "b", value: 2 },
      { memoryId: "c", value: 3 },
    ];
    const result = dedupByMemoryId(items);
    expect(result.unique).toEqual(items);
    expect(result.duplicates).toBe(0);
  });

  test("removes duplicates, keeping the first occurrence", () => {
    const a1 = { memoryId: "a", value: 1 };
    const a2 = { memoryId: "a", value: 2 }; // duplicate id, different payload
    const b = { memoryId: "b", value: 3 };
    const result = dedupByMemoryId([a1, a2, b]);
    expect(result.unique).toEqual([a1, b]);
    expect(result.duplicates).toBe(1);
  });

  test("counts duplicates accurately when an id repeats more than twice", () => {
    const result = dedupByMemoryId([
      { memoryId: "a" },
      { memoryId: "a" },
      { memoryId: "a" },
      { memoryId: "b" },
    ]);
    expect(result.unique.map((u) => u.memoryId)).toEqual(["a", "b"]);
    expect(result.duplicates).toBe(2);
  });

  test("handles empty input", () => {
    const result = dedupByMemoryId([]);
    expect(result.unique).toEqual([]);
    expect(result.duplicates).toBe(0);
  });

  test("preserves insertion order across distinct ids", () => {
    const items = [
      { memoryId: "c" },
      { memoryId: "a" },
      { memoryId: "b" },
      { memoryId: "a" }, // dup
      { memoryId: "d" },
    ];
    const result = dedupByMemoryId(items);
    expect(result.unique.map((u) => u.memoryId)).toEqual(["c", "a", "b", "d"]);
    expect(result.duplicates).toBe(1);
  });
});
