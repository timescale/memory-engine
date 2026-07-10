import { describe, expect, test } from "bun:test";
import { isBlankAppend } from "./memory.ts";

describe("isBlankAppend", () => {
  test("treats undefined and whitespace-only input as blank (no-op)", () => {
    for (const blank of [undefined, "", "   ", "\n", "\t\n ", "  \r\n  "]) {
      expect(isBlankAppend(blank)).toBe(true);
    }
  });

  test("treats any non-whitespace content as appendable", () => {
    for (const ok of ["x", " a ", "\nline\n", "0", "false"]) {
      expect(isBlankAppend(ok)).toBe(false);
    }
  });
});
