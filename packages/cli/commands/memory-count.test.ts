import { describe, expect, test } from "bun:test";
import {
  formatMemoryCount,
  parseMaxCount,
  uniqueExportFilename,
} from "./memory.ts";

describe("parseMaxCount", () => {
  test("returns undefined when omitted", () => {
    expect(parseMaxCount(undefined)).toBeUndefined();
  });

  test("accepts positive integers", () => {
    expect(parseMaxCount("1")).toBe(1);
    expect(parseMaxCount("100")).toBe(100);
  });

  test("rejects invalid values", () => {
    for (const value of ["0", "-1", "1.5", "abc", ""]) {
      expect(() => parseMaxCount(value)).toThrow(/Invalid --max-count/);
    }
  });
});

describe("formatMemoryCount", () => {
  test("formats exact counts", () => {
    expect(formatMemoryCount(0)).toBe("0 memories");
    expect(formatMemoryCount(1)).toBe("1 memory");
    expect(formatMemoryCount(2)).toBe("2 memories");
  });

  test("uses lower-bound wording when max count is reached", () => {
    expect(formatMemoryCount(1, 1)).toBe("at least 1 memory");
    expect(formatMemoryCount(100, 100)).toBe("at least 100 memories");
  });

  test("keeps exact wording when max count is not reached", () => {
    expect(formatMemoryCount(2, 3)).toBe("2 memories");
  });
});

describe("uniqueExportFilename", () => {
  test("appends .md once and leaves a non-colliding name clean", () => {
    const used = new Map<string, Set<string>>();
    expect(uniqueExportFilename("/d", "foo", "id1", used)).toBe("foo.md");
    expect(uniqueExportFilename("/d", "bar.md", "id2", used)).toBe("bar.md");
  });

  test("disambiguates `foo` vs `foo.md` (same on-disk name) by id", () => {
    const used = new Map<string, Set<string>>();
    expect(uniqueExportFilename("/d", "foo", "id1", used)).toBe("foo.md");
    // `foo.md` would overwrite the first file → gets the id inserted.
    expect(uniqueExportFilename("/d", "foo.md", "id2", used)).toBe(
      "foo.id2.md",
    );
  });

  test("treats names colliding only by case as a clash (portable to case-insensitive FS)", () => {
    const used = new Map<string, Set<string>>();
    expect(uniqueExportFilename("/d", "Foo", "id1", used)).toBe("Foo.md");
    expect(uniqueExportFilename("/d", "foo", "id2", used)).toBe("foo.id2.md");
  });

  test("scopes collisions per directory", () => {
    const used = new Map<string, Set<string>>();
    expect(uniqueExportFilename("/a", "foo", "id1", used)).toBe("foo.md");
    // Same name in a different directory is fine — no disambiguation.
    expect(uniqueExportFilename("/b", "foo", "id2", used)).toBe("foo.md");
  });

  test("throws if even the id-disambiguated name is already taken", () => {
    const used = new Map<string, Set<string>>();
    uniqueExportFilename("/d", "foo", "id1", used); // foo.md
    uniqueExportFilename("/d", "foo.X", "id3", used); // foo.X.md (named like an id)
    // `foo.md` (id X) → foo.md taken → foo.X.md also taken → error, not a guess.
    expect(() => uniqueExportFilename("/d", "foo.md", "X", used)).toThrow(
      /already taken/,
    );
  });
});
