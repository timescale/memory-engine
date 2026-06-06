import { describe, expect, test } from "bun:test";
import { isLegacyApiKey } from "./mcp.ts";

// Guards the CLI's copy of the legacy-key detector (duplicated from
// @memory.build/engine/core to avoid an engine dependency). Keep in sync with
// the engine version's tests.
describe("isLegacyApiKey", () => {
  const legacy = `me.abc123def456.lookupid12345678.${"s".repeat(32)}`;

  test("true for a 4-part legacy (space-scoped) key", () => {
    expect(isLegacyApiKey(legacy)).toBe(true);
  });

  test("false for a current 3-part key", () => {
    expect(isLegacyApiKey(`me.lookupid12345678.${"s".repeat(32)}`)).toBe(false);
  });

  test("false for an opaque session-like token", () => {
    expect(isLegacyApiKey("a".repeat(43))).toBe(false);
  });

  test("false for a 4-part token with a malformed slug", () => {
    expect(
      isLegacyApiKey(`me.BADSLUG78901.lookupid12345678.${"s".repeat(32)}`),
    ).toBe(false);
  });
});
