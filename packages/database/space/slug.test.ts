import { describe, expect, test } from "bun:test";
import { randomSlug } from "./migrate/test-utils";
import {
  isValidSlug,
  isValidSpaceSchema,
  schemaToSlug,
  slugToSchema,
} from "./slug";

describe("isValidSlug", () => {
  test("accepts 12 lowercase alphanumeric chars", () => {
    expect(isValidSlug("abcdef012345")).toBe(true);
    expect(isValidSlug("000000000000")).toBe(true);
    expect(isValidSlug("zzzzzzzzzzzz")).toBe(true);
  });

  test("rejects wrong length", () => {
    expect(isValidSlug("abc")).toBe(false);
    expect(isValidSlug("abcdef01234")).toBe(false); // 11
    expect(isValidSlug("abcdef0123456")).toBe(false); // 13
    expect(isValidSlug("")).toBe(false);
  });

  test("rejects uppercase and special characters", () => {
    expect(isValidSlug("ABCDEF012345")).toBe(false);
    expect(isValidSlug("abcdef-12345")).toBe(false);
    expect(isValidSlug("abcdef_12345")).toBe(false);
    expect(isValidSlug("abcde 012345")).toBe(false);
  });
});

describe("isValidSpaceSchema", () => {
  test("accepts me_ prefix + valid slug", () => {
    expect(isValidSpaceSchema("me_abcdef012345")).toBe(true);
  });

  test("rejects missing prefix or wrong shape", () => {
    expect(isValidSpaceSchema("abcdef012345")).toBe(false);
    expect(isValidSpaceSchema("me_ABCDEF012345")).toBe(false);
    expect(isValidSpaceSchema("me_abc")).toBe(false);
    expect(isValidSpaceSchema("core")).toBe(false);
    expect(isValidSpaceSchema("xx_abcdef012345")).toBe(false);
  });
});

describe("slugToSchema / schemaToSlug", () => {
  test("slugToSchema prepends me_", () => {
    expect(slugToSchema("abcdef012345")).toBe("me_abcdef012345");
  });

  test("schemaToSlug strips the me_ prefix", () => {
    expect(schemaToSlug("me_abcdef012345")).toBe("abcdef012345");
  });

  test("round-trips", () => {
    const slug = "0a1b2c3d4e5f";
    expect(schemaToSlug(slugToSchema(slug))).toBe(slug);
    expect(isValidSpaceSchema(slugToSchema(slug))).toBe(true);
  });
});

describe("randomSlug", () => {
  test("always produces a valid, schema-safe slug", () => {
    for (let i = 0; i < 1000; i++) {
      const slug = randomSlug();
      expect(isValidSlug(slug)).toBe(true);
      expect(isValidSpaceSchema(slugToSchema(slug))).toBe(true);
    }
  });

  test("is effectively unique across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(randomSlug());
    expect(seen.size).toBe(10_000);
  });
});
