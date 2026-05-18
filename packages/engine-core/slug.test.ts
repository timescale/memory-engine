import { describe, expect, test } from "bun:test";
import {
  isValidEngineSchema,
  isValidSlug,
  schemaToSlug,
  slugToSchema,
} from "./slug";

describe("engine slugs", () => {
  test("validates slugs", () => {
    expect(isValidSlug("abc123def456")).toBe(true);
    expect(isValidSlug("000000000000")).toBe(true);

    expect(isValidSlug("abc123def45")).toBe(false);
    expect(isValidSlug("abc123def4567")).toBe(false);
    expect(isValidSlug("ABC123def456")).toBe(false);
    expect(isValidSlug("abc123_def45")).toBe(false);
    expect(isValidSlug("abc123-def45")).toBe(false);
  });

  test("validates engine schemas", () => {
    expect(isValidEngineSchema("me_abc123def456")).toBe(true);
    expect(isValidEngineSchema("me_000000000000")).toBe(true);

    expect(isValidEngineSchema("abc123def456")).toBe(false);
    expect(isValidEngineSchema("me_abc123def45")).toBe(false);
    expect(isValidEngineSchema("me_abc123def4567")).toBe(false);
    expect(isValidEngineSchema("me_ABC123def456")).toBe(false);
    expect(isValidEngineSchema("me_abc123_def45")).toBe(false);
  });

  test("converts between slugs and schemas", () => {
    const slug = "abc123def456";
    const schema = "me_abc123def456";

    expect(slugToSchema(slug)).toBe(schema);
    expect(schemaToSlug(schema)).toBe(slug);
    expect(schemaToSlug(slugToSchema(slug))).toBe(slug);
  });
});
