import { describe, expect, test } from "bun:test";
import { describeMcpSpaceProblem, isSpaceSlug } from "../mcp/space.ts";
import { blankFlag, isLegacyApiKey } from "./mcp.ts";

// blankFlag normalizes the plugin's `--server/--api-key/--space ${user_config.X}`
// args: blank (or an unsubstituted placeholder) → undefined, so resolution falls
// back to the live `me` config instead of using the literal value.
describe("blankFlag", () => {
  test("empty string → undefined (falls back)", () => {
    expect(blankFlag("")).toBeUndefined();
  });

  test("unsubstituted ${...} placeholder → undefined (falls back)", () => {
    expect(blankFlag("${user_config.server}")).toBeUndefined();
    expect(blankFlag("${user_config.api_key}")).toBeUndefined();
  });

  test("undefined / non-string → undefined", () => {
    expect(blankFlag(undefined)).toBeUndefined();
    expect(blankFlag(123)).toBeUndefined();
  });

  test("a real value passes through unchanged", () => {
    expect(blankFlag("https://me.dev-us-east-1.ops.dev.timescale.com")).toBe(
      "https://me.dev-us-east-1.ops.dev.timescale.com",
    );
    expect(blankFlag("7plcwreyoxdd")).toBe("7plcwreyoxdd");
  });
});

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

describe("space slug validation", () => {
  const spaces = [
    { slug: "abc123def456", name: "default" },
    { slug: "def456abc123", name: "prod" },
    { slug: "aaa111bbb222", name: "dupe" },
    { slug: "ccc333ddd444", name: "dupe" },
  ];

  test("accepts immutable 12-character slugs", () => {
    expect(isSpaceSlug("abc123def456")).toBe(true);
    expect(describeMcpSpaceProblem("abc123def456", spaces)).toBeUndefined();
  });

  test("suggests the slug for a unique display-name match", () => {
    expect(isSpaceSlug("default")).toBe(false);
    expect(describeMcpSpaceProblem("default", spaces)).toBe(
      "Space 'default' is a display name, not a slug. Did you mean 'abc123def456'?",
    );
  });

  test("lists candidates for duplicate display-name matches", () => {
    expect(describeMcpSpaceProblem("dupe", spaces)).toBe(
      "Space 'dupe' is a display name used by multiple spaces. Use one of these slugs: dupe (aaa111bbb222), dupe (ccc333ddd444).",
    );
  });

  test("valid-looking unknown slug reports inaccessible or missing", () => {
    expect(describeMcpSpaceProblem("default12345", spaces)).toBe(
      "Space slug 'default12345' was not found or is not accessible with this credential. Run 'me space list' to see available slugs.",
    );
  });

  test("unknown non-slug asks for a valid slug, not a name", () => {
    expect(describeMcpSpaceProblem("missing", spaces)).toBe(
      "--space must refer to a valid space slug, not a space name. Run 'me space list' to see available slugs.",
    );
  });
});
