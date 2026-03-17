import { describe, expect, test } from "bun:test";
import {
  extractSchemaFromKey,
  formatApiKey,
  generateLookupId,
  generateSecret,
  hashSecret,
  parseApiKey,
  verifySecret,
} from "./api-key";

describe("generateLookupId", () => {
  test("generates 16-character string", () => {
    const id = generateLookupId();
    expect(id).toHaveLength(16);
  });

  test("only contains valid characters", () => {
    const id = generateLookupId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  test("generates unique values", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateLookupId());
    }
    expect(ids.size).toBe(100);
  });
});

describe("generateSecret", () => {
  test("generates 32-character string", () => {
    const secret = generateSecret();
    expect(secret).toHaveLength(32);
  });

  test("generates unique values", () => {
    const secrets = new Set<string>();
    for (let i = 0; i < 100; i++) {
      secrets.add(generateSecret());
    }
    expect(secrets.size).toBe(100);
  });
});

describe("hashSecret and verifySecret", () => {
  test("hash can be verified", async () => {
    const secret = generateSecret();
    const hash = await hashSecret(secret);

    expect(hash).toContain("$argon2");

    const valid = await verifySecret(secret, hash);
    expect(valid).toBe(true);
  });

  test("wrong secret fails verification", async () => {
    const secret = generateSecret();
    const hash = await hashSecret(secret);

    const wrongSecret = generateSecret();
    const valid = await verifySecret(wrongSecret, hash);
    expect(valid).toBe(false);
  });
});

describe("formatApiKey", () => {
  test("formats key as schema.lookupId.secret", () => {
    const key = formatApiKey(
      "me_abc123xyz789",
      "lookupid12345678",
      "secretsecretsecretsecretsecretse", // 32 chars
    );

    expect(key).toBe(
      "me_abc123xyz789.lookupid12345678.secretsecretsecretsecretsecretse",
    );
  });
});

describe("parseApiKey", () => {
  test("parses valid key", () => {
    const key =
      "me_abc123xyz789.lookupid12345678.secretsecretsecretsecretsecretse"; // 32-char secret
    const parsed = parseApiKey(key);

    expect(parsed).not.toBeNull();
    expect(parsed!.schema).toBe("me_abc123xyz789");
    expect(parsed!.lookupId).toBe("lookupid12345678");
    expect(parsed!.secret).toBe("secretsecretsecretsecretsecretse");
  });

  test("returns null for invalid format", () => {
    expect(parseApiKey("invalid")).toBeNull();
    expect(parseApiKey("too.many.parts.here")).toBeNull();
    expect(parseApiKey("no-dots")).toBeNull();
  });

  test("returns null for invalid schema", () => {
    const validLookupAndSecret =
      "lookupid12345678.secretsecretsecretsecretsecretse";
    // Wrong prefix
    expect(parseApiKey(`xx_abc123xyz789.${validLookupAndSecret}`)).toBeNull();
    // Too short
    expect(parseApiKey(`me_abc.${validLookupAndSecret}`)).toBeNull();
    // Too long
    expect(parseApiKey(`me_abc123xyz7890.${validLookupAndSecret}`)).toBeNull();
    // Uppercase
    expect(parseApiKey(`me_ABC123xyz789.${validLookupAndSecret}`)).toBeNull();
  });

  test("returns null for invalid lookupId", () => {
    const validSecret = "secretsecretsecretsecretsecretse";
    // Too short
    expect(parseApiKey(`me_abc123xyz789.short.${validSecret}`)).toBeNull();
    // Too long
    expect(
      parseApiKey(`me_abc123xyz789.lookupid123456789.${validSecret}`),
    ).toBeNull();
    // Invalid chars
    expect(
      parseApiKey(`me_abc123xyz789.lookup!d1234567.${validSecret}`),
    ).toBeNull();
  });

  test("returns null for invalid secret", () => {
    const validSchemaAndLookup = "me_abc123xyz789.lookupid12345678";
    // Too short
    expect(parseApiKey(`${validSchemaAndLookup}.short`)).toBeNull();
    // Too long (33 chars)
    expect(
      parseApiKey(`${validSchemaAndLookup}.secretsecretsecretsecretsecretseX`),
    ).toBeNull();
  });
});

describe("extractSchemaFromKey", () => {
  test("extracts schema from valid key", () => {
    const schema = extractSchemaFromKey(
      "me_abc123xyz789.lookupid12345678.secretsecretsecretsecretsecretse",
    );
    expect(schema).toBe("me_abc123xyz789");
  });

  test("returns null for invalid key", () => {
    expect(extractSchemaFromKey("invalid")).toBeNull();
    expect(extractSchemaFromKey("xx_abc123xyz789.rest")).toBeNull();
    expect(extractSchemaFromKey("me_short.rest")).toBeNull();
  });

  test("extracts without validating rest of key", () => {
    // This is intentional - extractSchemaFromKey is for fast routing
    const schema = extractSchemaFromKey("me_abc123xyz789.anything.else");
    expect(schema).toBe("me_abc123xyz789");
  });
});
