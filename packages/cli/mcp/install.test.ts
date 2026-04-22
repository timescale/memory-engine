/**
 * Unit tests for MCP install helpers.
 */
import { describe, expect, test } from "bun:test";
import { buildMeCommand, buildOpenCodeConfig } from "./install.ts";

describe("buildMeCommand", () => {
  test("uses bare 'me' command on PATH", () => {
    const cmd = buildMeCommand("test-key-123", "https://api.memory.build");
    expect(cmd[0]).toBe("me");
    expect(cmd[1]).toBe("mcp");
  });

  test("includes --api-key and --server with correct values", () => {
    const cmd = buildMeCommand("k", "https://example.com");
    expect(cmd).toEqual([
      "me",
      "mcp",
      "--api-key",
      "k",
      "--server",
      "https://example.com",
    ]);
  });
});

describe("buildOpenCodeConfig", () => {
  const meCmd = ["me", "mcp", "--api-key", "k", "--server", "https://x"];

  test("adds memory-engine entry to empty config", () => {
    const { config, existed } = buildOpenCodeConfig({}, meCmd);
    expect(existed).toBe(false);
    expect(config).toEqual({
      mcp: {
        "memory-engine": {
          type: "local",
          command: meCmd,
        },
      },
    });
  });

  test("preserves unrelated top-level keys", () => {
    const existing = { theme: "dark", model: "claude-sonnet" };
    const { config } = buildOpenCodeConfig(existing, meCmd);
    expect(config.theme).toBe("dark");
    expect(config.model).toBe("claude-sonnet");
    expect((config.mcp as Record<string, unknown>)["memory-engine"]).toEqual({
      type: "local",
      command: meCmd,
    });
  });

  test("preserves sibling mcp servers", () => {
    const existing = {
      mcp: {
        "other-server": { type: "local", command: ["other"] },
      },
    };
    const { config, existed } = buildOpenCodeConfig(existing, meCmd);
    expect(existed).toBe(false);
    const mcp = config.mcp as Record<string, unknown>;
    expect(mcp["other-server"]).toEqual({
      type: "local",
      command: ["other"],
    });
    expect(mcp["memory-engine"]).toEqual({
      type: "local",
      command: meCmd,
    });
  });

  test("overwrites prior memory-engine entry and reports existed=true", () => {
    const existing = {
      mcp: {
        "memory-engine": { type: "local", command: ["me", "old"] },
      },
    };
    const { config, existed } = buildOpenCodeConfig(existing, meCmd);
    expect(existed).toBe(true);
    const mcp = config.mcp as Record<string, unknown>;
    expect(mcp["memory-engine"]).toEqual({
      type: "local",
      command: meCmd,
    });
  });

  test("replaces non-object mcp key with a fresh object", () => {
    const existing = { mcp: "not-an-object" };
    const { config } = buildOpenCodeConfig(existing, meCmd);
    expect(config.mcp).toEqual({
      "memory-engine": {
        type: "local",
        command: meCmd,
      },
    });
  });
});
