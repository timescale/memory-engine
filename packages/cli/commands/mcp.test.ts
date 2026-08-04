import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import type { McpServerOptions } from "../mcp/server.ts";
import {
  blankFlag,
  createMcpRunAction,
  isLegacyApiKey,
  resolveMcpSpace,
} from "./mcp.ts";

// blankFlag normalizes the plugin's `--server/--api-key/--space ${user_config.X}`
// args: blank (or an unsubstituted placeholder) → undefined, so resolution falls
// back to the live `me` config instead of using the literal value.
describe("blankFlag", () => {
  test("empty string → undefined (falls back)", () => {
    expect(blankFlag("")).toBeUndefined();
  });

  test("whitespace-only string → undefined (falls back)", () => {
    expect(blankFlag(" ")).toBeUndefined();
    expect(blankFlag("   \t\n")).toBeUndefined();
  });

  test("unsubstituted ${...} placeholder → undefined (falls back)", () => {
    expect(blankFlag("${user_config.server}")).toBeUndefined();
    expect(blankFlag("${user_config.api_key}")).toBeUndefined();
  });

  test("whitespace-padded ${...} placeholder → undefined (falls back)", () => {
    expect(blankFlag("  ${user_config.space}  ")).toBeUndefined();
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

  test("a whitespace-padded real value is trimmed", () => {
    expect(blankFlag("  7plcwreyoxdd  ")).toBe("7plcwreyoxdd");
    expect(blankFlag("\thttps://api.memory.build\n")).toBe(
      "https://api.memory.build",
    );
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

describe("resolveMcpSpace", () => {
  test("a --space flag locks the MCP tool surface", () => {
    expect(resolveMcpSpace("flagspace001", undefined)).toEqual({
      lockedSpace: "flagspace001",
      spaceMode: "locked",
    });
  });

  test("ME_SPACE locks the MCP tool surface", () => {
    expect(resolveMcpSpace(undefined, "envspace0001")).toEqual({
      lockedSpace: "envspace0001",
      spaceMode: "locked",
    });
  });

  test("a blank plugin flag starts multi-space mode", () => {
    expect(resolveMcpSpace("${user_config.space}", undefined)).toEqual({
      spaceMode: "multi",
    });
  });

  test("no explicit space starts multi-space mode", () => {
    expect(resolveMcpSpace(undefined, undefined)).toEqual({
      spaceMode: "multi",
    });
  });

  test("an empty ME_SPACE starts multi-space mode", () => {
    expect(resolveMcpSpace(undefined, "")).toEqual({
      spaceMode: "multi",
    });
  });

  test("a whitespace-only ME_SPACE starts multi-space mode", () => {
    expect(resolveMcpSpace(undefined, "   ")).toEqual({
      spaceMode: "multi",
    });
  });

  test("a --space flag wins over ME_SPACE when both are set", () => {
    expect(resolveMcpSpace("flagspace001", "envspace0001")).toEqual({
      lockedSpace: "flagspace001",
      spaceMode: "locked",
    });
  });

  test("a blank --space flag falls back to ME_SPACE", () => {
    expect(resolveMcpSpace("${user_config.space}", "envspace0001")).toEqual({
      lockedSpace: "envspace0001",
      spaceMode: "locked",
    });
  });
});

test("manual MCP startup passes multi-space mode instead of an active-space default", async () => {
  const previousSpace = process.env.ME_SPACE;
  const previousAgent = process.env.AI_AGENT;
  delete process.env.ME_SPACE;
  delete process.env.AI_AGENT;
  try {
    let received: McpServerOptions | undefined;
    const action = createMcpRunAction({
      resolveCredentials: () => ({
        server: "https://api.example.com",
        loggedIn: true,
        activeSpace: "ignoredspace",
        captureEnabled: false,
      }),
      memoryBearer: () => ({
        getToken: async () => "token",
        onUnauthorized: async () => undefined,
      }),
      runMcpServer: async (options) => {
        received = options;
      },
    });
    const command = new Command();
    command.parse(["node", "test"]);

    await action({}, command);
    expect(received).toMatchObject({
      server: "https://api.example.com",
      spaceMode: "multi",
    });
  } finally {
    if (previousSpace === undefined) delete process.env.ME_SPACE;
    else process.env.ME_SPACE = previousSpace;
    if (previousAgent === undefined) delete process.env.AI_AGENT;
    else process.env.AI_AGENT = previousAgent;
  }
});
