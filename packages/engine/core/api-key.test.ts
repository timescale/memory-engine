import { describe, expect, test } from "bun:test";
import {
  formatApiKey,
  generateLookupId,
  generateSecret,
  hashApiKeySecret,
  parseApiKey,
} from "./api-key";

describe("generateLookupId", () => {
  test("generates a 16-char string", () => {
    expect(generateLookupId()).toHaveLength(16);
  });

  test("only contains valid lookup_id characters", () => {
    expect(generateLookupId()).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  test("generates unique values", () => {
    expect(generateLookupId()).not.toBe(generateLookupId());
  });
});

describe("generateSecret", () => {
  test("generates a 32-char string", () => {
    expect(generateSecret()).toHaveLength(32);
  });

  test("only contains base64url characters", () => {
    expect(generateSecret()).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  test("generates unique values", () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });
});

describe("hashApiKeySecret", () => {
  test("is a stable hex sha256 digest", () => {
    const h = hashApiKeySecret("a-secret");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKeySecret("a-secret")).toBe(h);
  });

  test("different secrets produce different hashes", () => {
    expect(hashApiKeySecret("secret-a")).not.toBe(hashApiKeySecret("secret-b"));
  });
});

describe("formatApiKey", () => {
  test("formats key with all parts", () => {
    expect(
      formatApiKey("abc123def456", "lookupid12345678", "s".repeat(32)),
    ).toBe(`me.abc123def456.lookupid12345678.${"s".repeat(32)}`);
  });
});

describe("parseApiKey", () => {
  const valid = `me.abc123def456.lookupid12345678.${"s".repeat(32)}`;

  test("parses a valid key (round-trips with formatApiKey)", () => {
    const parsed = parseApiKey(valid);
    expect(parsed).toEqual({
      spaceSlug: "abc123def456",
      lookupId: "lookupid12345678",
      secret: "s".repeat(32),
    });
    if (parsed) {
      expect(
        formatApiKey(parsed.spaceSlug, parsed.lookupId, parsed.secret),
      ).toBe(valid);
    }
  });

  test("returns null for the wrong prefix", () => {
    expect(
      parseApiKey(`x.abc123def456.lookupid12345678.${"s".repeat(32)}`),
    ).toBeNull();
  });

  test("returns null for an invalid spaceSlug (uppercase)", () => {
    expect(
      parseApiKey(`me.ABC123def456.lookupid12345678.${"s".repeat(32)}`),
    ).toBeNull();
  });

  test("returns null for a short spaceSlug", () => {
    expect(parseApiKey(`me.abc.lookupid12345678.${"s".repeat(32)}`)).toBeNull();
  });

  test("returns null for an invalid lookupId", () => {
    expect(parseApiKey(`me.abc123def456.short.${"s".repeat(32)}`)).toBeNull();
  });

  test("returns null for the wrong secret length", () => {
    expect(parseApiKey("me.abc123def456.lookupid12345678.tooshort")).toBeNull();
  });

  test("returns null for the wrong number of parts", () => {
    expect(parseApiKey("me.abc123def456.lookupid12345678")).toBeNull();
  });
});
