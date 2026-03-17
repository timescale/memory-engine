import { describe, expect, test } from "bun:test";
import {
  isValidEngineSchema,
  isValidSlug,
  schemaToSlug,
  slugToSchema,
} from "./discover";

describe("isValidEngineSchema", () => {
  test("valid 12-char lowercase alphanumeric", () => {
    expect(isValidEngineSchema("me_abcdef123456")).toBe(true);
  });

  test("valid all digits", () => {
    expect(isValidEngineSchema("me_000000000000")).toBe(true);
  });

  test("valid all letters", () => {
    expect(isValidEngineSchema("me_abcdefghijkl")).toBe(true);
  });

  test("rejects too short", () => {
    expect(isValidEngineSchema("me_abc")).toBe(false);
  });

  test("rejects too long", () => {
    expect(isValidEngineSchema("me_abcdef1234567")).toBe(false);
  });

  test("rejects uppercase", () => {
    expect(isValidEngineSchema("me_ABCDEF123456")).toBe(false);
  });

  test("rejects wrong prefix", () => {
    expect(isValidEngineSchema("xx_abcdef123456")).toBe(false);
  });

  test("rejects no prefix", () => {
    expect(isValidEngineSchema("abcdef123456")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isValidEngineSchema("")).toBe(false);
  });

  test("rejects special characters", () => {
    expect(isValidEngineSchema("me_abcdef12345!")).toBe(false);
  });

  test("rejects public schema", () => {
    expect(isValidEngineSchema("public")).toBe(false);
  });

  test("rejects embedding schema", () => {
    expect(isValidEngineSchema("embedding")).toBe(false);
  });
});

describe("isValidSlug", () => {
  test("valid 12-char lowercase alphanumeric", () => {
    expect(isValidSlug("abcdef123456")).toBe(true);
  });

  test("valid all digits", () => {
    expect(isValidSlug("000000000000")).toBe(true);
  });

  test("rejects too short", () => {
    expect(isValidSlug("abc")).toBe(false);
  });

  test("rejects too long", () => {
    expect(isValidSlug("abcdef1234567")).toBe(false);
  });

  test("rejects uppercase", () => {
    expect(isValidSlug("ABCDEF123456")).toBe(false);
  });

  test("rejects special characters", () => {
    expect(isValidSlug("abcdef12345!")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isValidSlug("")).toBe(false);
  });

  test("rejects hyphens", () => {
    expect(isValidSlug("abc-def-12345")).toBe(false);
  });
});

describe("slugToSchema / schemaToSlug", () => {
  test("round-trip slug → schema → slug", () => {
    const slug = "abcdef123456";
    expect(schemaToSlug(slugToSchema(slug))).toBe(slug);
  });

  test("slugToSchema adds me_ prefix", () => {
    expect(slugToSchema("abcdef123456")).toBe("me_abcdef123456");
  });

  test("schemaToSlug removes me_ prefix", () => {
    expect(schemaToSlug("me_abcdef123456")).toBe("abcdef123456");
  });
});
