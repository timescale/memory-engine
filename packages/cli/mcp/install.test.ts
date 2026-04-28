/**
 * Unit tests for MCP install helpers.
 */
import { describe, expect, test } from "bun:test";
import { buildMeCommand, buildOpenCodeConfig, MCP_TOOLS } from "./install.ts";

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

  test("adds me entry to empty config", () => {
    const { config, existed } = buildOpenCodeConfig({}, meCmd);
    expect(existed).toBe(false);
    expect(config).toEqual({
      mcp: {
        me: {
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
    expect((config.mcp as Record<string, unknown>).me).toEqual({
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
    expect(mcp.me).toEqual({
      type: "local",
      command: meCmd,
    });
  });

  test("overwrites prior me entry and reports existed=true", () => {
    const existing = {
      mcp: {
        me: { type: "local", command: ["me", "old"] },
      },
    };
    const { config, existed } = buildOpenCodeConfig(existing, meCmd);
    expect(existed).toBe(true);
    const mcp = config.mcp as Record<string, unknown>;
    expect(mcp.me).toEqual({
      type: "local",
      command: meCmd,
    });
  });

  test("replaces non-object mcp key with a fresh object", () => {
    const existing = { mcp: "not-an-object" };
    const { config } = buildOpenCodeConfig(existing, meCmd);
    expect(config.mcp).toEqual({
      me: {
        type: "local",
        command: meCmd,
      },
    });
  });
});

// Helpers to fish a tool out of the registry without leaking internal types.
function findCliTool(bin: string) {
  const tool = MCP_TOOLS.find((t) => t.bin === bin);
  if (!tool || tool.method !== "cli") {
    throw new Error(`expected CLI tool with bin '${bin}'`);
  }
  return tool;
}

describe("Claude Code scope handling", () => {
  const meCmd = ["me", "mcp", "--api-key", "k", "--server", "https://x"];
  const claude = findCliTool("claude");

  test("addCmd defaults to --scope user", () => {
    expect(claude.addCmd(meCmd, {})).toEqual([
      "claude",
      "mcp",
      "add",
      "--scope",
      "user",
      "me",
      "--",
      ...meCmd,
    ]);
  });

  test("addCmd honors explicit project scope", () => {
    expect(claude.addCmd(meCmd, { scope: "project" })).toEqual([
      "claude",
      "mcp",
      "add",
      "--scope",
      "project",
      "me",
      "--",
      ...meCmd,
    ]);
  });

  test("addCmd honors explicit local scope", () => {
    expect(claude.addCmd(meCmd, { scope: "local" })).toEqual([
      "claude",
      "mcp",
      "add",
      "--scope",
      "local",
      "me",
      "--",
      ...meCmd,
    ]);
  });

  test("removeCmd defaults to --scope user", () => {
    expect(claude.removeCmd({})).toEqual([
      "claude",
      "mcp",
      "remove",
      "--scope",
      "user",
      "me",
    ]);
  });

  test("removeCmd honors explicit project scope", () => {
    expect(claude.removeCmd({ scope: "project" })).toEqual([
      "claude",
      "mcp",
      "remove",
      "--scope",
      "project",
      "me",
    ]);
  });
});

describe("Gemini CLI scope handling", () => {
  const meCmd = ["me", "mcp", "--api-key", "k", "--server", "https://x"];
  const gemini = findCliTool("gemini");

  test("addCmd defaults to --scope user", () => {
    expect(gemini.addCmd(meCmd, {})).toEqual([
      "gemini",
      "mcp",
      "add",
      "--scope",
      "user",
      "me",
      ...meCmd,
    ]);
  });

  test("addCmd honors explicit project scope", () => {
    expect(gemini.addCmd(meCmd, { scope: "project" })).toEqual([
      "gemini",
      "mcp",
      "add",
      "--scope",
      "project",
      "me",
      ...meCmd,
    ]);
  });

  test("removeCmd defaults to --scope user", () => {
    expect(gemini.removeCmd({})).toEqual([
      "gemini",
      "mcp",
      "remove",
      "--scope",
      "user",
      "me",
    ]);
  });
});

describe("Codex CLI (no scope)", () => {
  const meCmd = ["me", "mcp", "--api-key", "k", "--server", "https://x"];
  const codex = findCliTool("codex");

  test("addCmd ignores scope opt", () => {
    expect(codex.addCmd(meCmd, { scope: "project" })).toEqual([
      "codex",
      "mcp",
      "add",
      "me",
      "--",
      ...meCmd,
    ]);
  });

  test("removeCmd ignores scope opt", () => {
    expect(codex.removeCmd({ scope: "project" })).toEqual([
      "codex",
      "mcp",
      "remove",
      "me",
    ]);
  });
});
