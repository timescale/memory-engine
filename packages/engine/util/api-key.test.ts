import { describe, expect, test } from "bun:test";
import {
  extractEngineSlug,
  formatApiKey,
  generateLookupId,
  generateSecret,
  hashSecret,
  parseApiKey,
  verifySecret,
} from "./api-key";

describe("generateLookupId", () => {
  test("generates 16-char string", () => {
    const id = generateLookupId();
    expect(id).toHaveLength(16);
  });

  test("only contains valid characters", () => {
    const id = generateLookupId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  test("generates unique values", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateLookupId()));
    expect(ids.size).toBe(100);
  });
});

describe("generateSecret", () => {
  test("generates 32-char string", () => {
    const secret = generateSecret();
    expect(secret).toHaveLength(32);
  });

  test("only contains base64url characters", () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  test("generates unique values", () => {
    const secrets = new Set(
      Array.from({ length: 100 }, () => generateSecret()),
    );
    expect(secrets.size).toBe(100);
  });
});

describe("hashSecret / verifySecret", () => {
  test("hash and verify round-trip", async () => {
    const secret = generateSecret();
    const hash = await hashSecret(secret);

    expect(await verifySecret(secret, hash)).toBe(true);
    expect(await verifySecret("wrong-secret", hash)).toBe(false);
  });

  test("different secrets produce different hashes", async () => {
    const secret1 = generateSecret();
    const secret2 = generateSecret();
    const hash1 = await hashSecret(secret1);
    const hash2 = await hashSecret(secret2);

    expect(hash1).not.toBe(hash2);
  });
});

describe("formatApiKey", () => {
  test("formats key with all parts", () => {
    const key = formatApiKey(
      "abc123xyz789",
      "Sh00uLs5rmSHHun3",
      "secret32charslong_______________",
    );
    expect(key).toBe(
      "me.abc123xyz789.Sh00uLs5rmSHHun3.secret32charslong_______________",
    );
  });
});

describe("parseApiKey", () => {
  // 32-char secret for tests
  const validSecret = "pREy3xfnbCpgUXiaBcDeFgHiJkLm1234";

  test("parses valid key", () => {
    const key = `me.abc123xyz789.Sh00uLs5rmSHHun3.${validSecret}`;
    const parsed = parseApiKey(key);

    expect(parsed).toEqual({
      engineSlug: "abc123xyz789",
      lookupId: "Sh00uLs5rmSHHun3",
      secret: validSecret,
    });
  });

  test("returns null for wrong prefix", () => {
    const key = `xx.abc123xyz789.Sh00uLs5rmSHHun3.${validSecret}`;
    expect(parseApiKey(key)).toBeNull();
  });

  test("returns null for invalid engineSlug (uppercase)", () => {
    const key = `me.ABC123xyz789.Sh00uLs5rmSHHun3.${validSecret}`;
    expect(parseApiKey(key)).toBeNull();
  });

  test("returns null for short engineSlug", () => {
    const key = `me.abc123.Sh00uLs5rmSHHun3.${validSecret}`;
    expect(parseApiKey(key)).toBeNull();
  });

  test("returns null for invalid lookupId", () => {
    const key = `me.abc123xyz789.short.${validSecret}`;
    expect(parseApiKey(key)).toBeNull();
  });

  test("returns null for wrong secret length", () => {
    const key = "me.abc123xyz789.Sh00uLs5rmSHHun3.tooshort";
    expect(parseApiKey(key)).toBeNull();
  });

  test("returns null for wrong number of parts", () => {
    expect(parseApiKey("me.abc123xyz789.Sh00uLs5rmSHHun3")).toBeNull();
    expect(parseApiKey("me.abc123xyz789")).toBeNull();
    expect(parseApiKey("invalid")).toBeNull();
  });
});

describe("extractEngineSlug", () => {
  const validSecret = "pREy3xfnbCpgUXiaBcDeFgHiJkLm1234";

  test("extracts slug from valid key", () => {
    const key = `me.abc123xyz789.Sh00uLs5rmSHHun3.${validSecret}`;
    expect(extractEngineSlug(key)).toBe("abc123xyz789");
  });

  test("returns null for invalid key", () => {
    expect(extractEngineSlug("invalid")).toBeNull();
    expect(extractEngineSlug("me.INVALID.x.y")).toBeNull();
  });
});
