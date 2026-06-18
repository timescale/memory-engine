import { describe, expect, test } from "bun:test";
import { formatMemoryCount, parseMaxCount } from "./memory.ts";

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
