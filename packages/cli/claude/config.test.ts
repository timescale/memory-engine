/**
 * Unit tests for Claude plugin config parsing.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPluginConfig } from "./config.ts";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "me-claude-config-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("readPluginConfig", () => {
  test("reads valid plugin-mode config", () => {
    withTempDir((dir) => {
      writeFileSync(
        join(dir, "config.yaml"),
        [
          "server: https://api.memory.build",
          "engine: abc123",
          "api_key: me.abc123.xxx.yyy",
          "tree_prefix: claude_code.sessions",
          "mode: plugin",
          "installed_at: 2026-04-23T10:00:00Z",
          "installed_by: 0.1.17",
        ].join("\n"),
      );

      const config = readPluginConfig(dir);
      expect(config.server).toBe("https://api.memory.build");
      expect(config.engine).toBe("abc123");
      expect(config.api_key).toBe("me.abc123.xxx.yyy");
      expect(config.tree_prefix).toBe("claude_code.sessions");
      expect(config.mode).toBe("plugin");
      expect(config.installed_at).toBe("2026-04-23T10:00:00Z");
      expect(config.installed_by).toBe("0.1.17");
    });
  });

  test("reads valid mcp-only config", () => {
    withTempDir((dir) => {
      writeFileSync(
        join(dir, "config.yaml"),
        [
          "server: https://api.memory.build",
          "engine: abc123",
          "api_key: me.abc123.xxx.yyy",
          "tree_prefix: claude_code.sessions",
          "mode: mcp-only",
        ].join("\n"),
      );

      const config = readPluginConfig(dir);
      expect(config.mode).toBe("mcp-only");
      expect(config.installed_at).toBeUndefined();
    });
  });

  test("throws on missing file", () => {
    withTempDir((dir) => {
      expect(() => readPluginConfig(dir)).toThrow(/not found/);
    });
  });

  test("throws on invalid mode", () => {
    withTempDir((dir) => {
      writeFileSync(
        join(dir, "config.yaml"),
        [
          "server: https://api.memory.build",
          "engine: abc123",
          "api_key: me.abc.x.y",
          "tree_prefix: p",
          "mode: bogus",
        ].join("\n"),
      );

      expect(() => readPluginConfig(dir)).toThrow(/mode must be/);
    });
  });

  test("throws on missing required field", () => {
    withTempDir((dir) => {
      writeFileSync(
        join(dir, "config.yaml"),
        [
          "server: https://api.memory.build",
          "engine: abc123",
          "tree_prefix: p",
          "mode: plugin",
        ].join("\n"),
      );

      expect(() => readPluginConfig(dir)).toThrow(/api_key/);
    });
  });

  test("throws on malformed YAML", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "config.yaml"), "not: valid: yaml: at: all:");
      expect(() => readPluginConfig(dir)).toThrow(/parse/);
    });
  });
});
