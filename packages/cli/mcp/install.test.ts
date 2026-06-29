/**
 * Unit tests for MCP install helpers.
 */
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildMeCommand,
  buildOpenCodeConfig,
  MCP_TOOLS,
  openCodeConfigPath,
} from "./install.ts";

describe("buildMeCommand", () => {
  test("uses bare 'me' command on PATH", () => {
    const cmd = buildMeCommand({ server: "https://api.memory.build" });
    expect(cmd[0]).toBe("me");
    expect(cmd[1]).toBe("mcp");
  });

  test("session default bakes only --server (token + space resolve at runtime)", () => {
    const cmd = buildMeCommand({ server: "https://example.com" });
    expect(cmd).toEqual(["me", "mcp", "--server", "https://example.com"]);
    expect(cmd).not.toContain("--api-key");
    expect(cmd).not.toContain("--space");
  });

  test("pins --space when given (session path with explicit space)", () => {
    const cmd = buildMeCommand({
      server: "https://example.com",
      space: "abc123def456",
    });
    expect(cmd).toEqual([
      "me",
      "mcp",
      "--server",
      "https://example.com",
      "--space",
      "abc123def456",
    ]);
  });

  test("headless agent bakes --api-key and --space", () => {
    const cmd = buildMeCommand({
      server: "https://example.com",
      apiKey: "k",
      space: "abc123def456",
    });
    expect(cmd).toEqual([
      "me",
      "mcp",
      "--server",
      "https://example.com",
      "--api-key",
      "k",
      "--space",
      "abc123def456",
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

describe("openCodeConfigPath scope", () => {
  const userPath = join(homedir(), ".config", "opencode", "opencode.json");

  test("defaults to the global user config", () => {
    expect(openCodeConfigPath()).toBe(userPath);
    expect(openCodeConfigPath({ scope: "user" })).toBe(userPath);
  });

  test("project scope targets <projectDir>/opencode.json", () => {
    expect(openCodeConfigPath({ scope: "project", projectDir: "/repo" })).toBe(
      join("/repo", "opencode.json"),
    );
  });

  test("project scope without projectDir falls back to cwd", () => {
    expect(openCodeConfigPath({ scope: "project" })).toBe(
      join(process.cwd(), "opencode.json"),
    );
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
