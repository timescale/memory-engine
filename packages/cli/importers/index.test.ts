/**
 * Tests for importer helpers in `index.ts`.
 */
import { describe, expect, test } from "bun:test";
import { dedupBy } from "./index.ts";

const byKey = (item: { key: string }) => item.key;

describe("dedupBy", () => {
  test("returns input unchanged when all keys are unique", () => {
    const items = [
      { key: "a", value: 1 },
      { key: "b", value: 2 },
      { key: "c", value: 3 },
    ];
    const result = dedupBy(items, byKey);
    expect(result.unique).toEqual(items);
    expect(result.duplicates).toBe(0);
  });

  test("removes duplicates, keeping the first occurrence", () => {
    const a1 = { key: "a", value: 1 };
    const a2 = { key: "a", value: 2 }; // duplicate key, different payload
    const b = { key: "b", value: 3 };
    const result = dedupBy([a1, a2, b], byKey);
    expect(result.unique).toEqual([a1, b]);
    expect(result.duplicates).toBe(1);
  });

  test("counts duplicates accurately when a key repeats more than twice", () => {
    const result = dedupBy(
      [{ key: "a" }, { key: "a" }, { key: "a" }, { key: "b" }],
      byKey,
    );
    expect(result.unique.map((u) => u.key)).toEqual(["a", "b"]);
    expect(result.duplicates).toBe(2);
  });

  test("handles empty input", () => {
    const result = dedupBy([] as { key: string }[], byKey);
    expect(result.unique).toEqual([]);
    expect(result.duplicates).toBe(0);
  });

  test("preserves insertion order across distinct keys", () => {
    const items = [
      { key: "c" },
      { key: "a" },
      { key: "b" },
      { key: "a" }, // dup
      { key: "d" },
    ];
    const result = dedupBy(items, byKey);
    expect(result.unique.map((u) => u.key)).toEqual(["c", "a", "b", "d"]);
    expect(result.duplicates).toBe(1);
  });
});
