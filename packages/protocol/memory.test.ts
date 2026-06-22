import { describe, expect, test } from "bun:test";
import {
  memoryNameSchema,
  memoryPathSchema,
  onConflictSchema,
} from "./fields.ts";
import { memoryCreateParams, memoryGetByPathParams } from "./memory.ts";

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
      "",
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

describe("memoryPathSchema", () => {
  test("accepts a path whose leaf is a valid memory name", () => {
    for (const ok of [
      "share/auth/jwt-rotation",
      "/share/auth/jwt-rotation",
      "~/notes/todo",
      "share/config.yaml",
      "jwt-rotation", // no slash → leaf is the whole string
    ]) {
      expect(memoryPathSchema.safeParse(ok).success).toBe(true);
    }
  });

  test("rejects a trailing slash (empty leaf) or a leaf with name-illegal chars", () => {
    for (const bad of [
      "", // empty
      "share/auth/", // trailing slash → empty leaf
      "share/.hidden", // leaf starts with '.'
      "share/-x", // leaf starts with '-'
      "~", // leaf is '~' (not a valid name)
      "share/has space",
    ]) {
      expect(memoryPathSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("getByPath params reject an invalid path (VALIDATION_ERROR, not NOT_FOUND)", () => {
    expect(
      memoryGetByPathParams.safeParse({ path: "share/auth/" }).success,
    ).toBe(false);
    expect(
      memoryGetByPathParams.safeParse({ path: "share/auth/jwt-rotation" })
        .success,
    ).toBe(true);
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
