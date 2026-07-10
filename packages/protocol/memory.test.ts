import { describe, expect, test } from "bun:test";
import {
  memoryNameSchema,
  memoryPathSchema,
  onConflictSchema,
} from "./fields.ts";
import {
  memoryAppendParams,
  memoryAppendResult,
  memoryCreateParams,
  memoryGetByPathParams,
} from "./memory.ts";

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

describe("memoryAppendParams", () => {
  const ID = "018f1138-7f07-7c48-8bd1-c9a6b1095978";
  const HASH = "0".repeat(32);

  test("accepts a minimal append (id + content + idempotencyKey)", () => {
    expect(
      memoryAppendParams.safeParse({
        id: ID,
        content: "more",
        idempotencyKey: "op-1",
      }).success,
    ).toBe(true);
  });

  test("accepts optional separator and versionHash", () => {
    expect(
      memoryAppendParams.safeParse({
        id: ID,
        content: "more",
        separator: "\n",
        versionHash: HASH,
        idempotencyKey: "op-1",
      }).success,
    ).toBe(true);
  });

  test("requires id, content, and idempotencyKey", () => {
    expect(
      memoryAppendParams.safeParse({ content: "x", idempotencyKey: "op-1" })
        .success,
    ).toBe(false); // missing id
    expect(
      memoryAppendParams.safeParse({ id: ID, idempotencyKey: "op-1" }).success,
    ).toBe(false); // missing content
    expect(memoryAppendParams.safeParse({ id: ID, content: "x" }).success).toBe(
      false,
    ); // missing idempotencyKey
    expect(
      memoryAppendParams.safeParse({
        id: ID,
        content: "",
        idempotencyKey: "op",
      }).success,
    ).toBe(false); // empty content
  });

  test("rejects a non-uuidv7 id and a wrong-length versionHash", () => {
    expect(
      memoryAppendParams.safeParse({
        id: "not-a-uuid",
        content: "x",
        idempotencyKey: "op-1",
      }).success,
    ).toBe(false);
    expect(
      memoryAppendParams.safeParse({
        id: ID,
        content: "x",
        versionHash: "tooshort",
        idempotencyKey: "op-1",
      }).success,
    ).toBe(false);
  });
});

describe("memoryAppendResult", () => {
  test("accepts a compact result and rejects a body field", () => {
    expect(
      memoryAppendResult.safeParse({
        id: "m1",
        version: 3,
        versionHash: "0".repeat(32),
        appendedBytes: 12,
        contentLength: 40,
        replayed: false,
      }).success,
    ).toBe(true);
    // The compact result must never carry a version < 1.
    expect(
      memoryAppendResult.safeParse({
        id: "m1",
        version: 0,
        versionHash: "0".repeat(32),
        appendedBytes: 12,
        contentLength: 40,
        replayed: false,
      }).success,
    ).toBe(false);
  });
});
