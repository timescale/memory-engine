import { describe, expect, test } from "bun:test";
import { memoryNameSchema, onConflictSchema } from "./fields.ts";
import { memoryCreateParams } from "./memory.ts";

describe("memoryNameSchema", () => {
  test("accepts filename-like slugs (dots, hyphens, underscores, mixed case)", () => {
    for (const ok of [
      "jwt-rotation",
      "config.yaml",
      "README.md",
      "v1.2_notes",
      "a",
    ]) {
      expect(memoryNameSchema.safeParse(ok).success).toBe(true);
    }
  });

  test("rejects slashes, spaces, leading dot/hyphen, and > 128 chars", () => {
    for (const bad of [
      "a/b",
      "has space",
      ".hidden",
      "..",
      "-x",
      "a".repeat(129),
    ]) {
      expect(memoryNameSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("onConflictSchema", () => {
  test("accepts error|replace|ignore, rejects others", () => {
    for (const ok of ["error", "replace", "ignore"]) {
      expect(onConflictSchema.safeParse(ok).success).toBe(true);
    }
    expect(onConflictSchema.safeParse("upsert").success).toBe(false);
  });
});

describe("memoryCreateParams", () => {
  test("name + onConflict are optional and validated", () => {
    expect(
      memoryCreateParams.safeParse({ content: "x", tree: "share" }).success,
    ).toBe(true);
    expect(
      memoryCreateParams.safeParse({
        content: "x",
        tree: "share/auth",
        name: "jwt-rotation",
        onConflict: "replace",
      }).success,
    ).toBe(true);
    expect(
      memoryCreateParams.safeParse({
        content: "x",
        tree: "share",
        name: "bad name",
      }).success,
    ).toBe(false);
  });
});
