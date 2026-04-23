/**
 * Unit tests for Claude plugin uninstall logic.
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uninstallClaudePlugin } from "./uninstall.ts";

function withTempDirs<T>(
  fn: (paths: { pluginDir: string; settingsPath: string }) => T,
): T {
  const root = mkdtempSync(join(tmpdir(), "me-claude-uninstall-test-"));
  const pluginDir = join(root, "plugin");
  const settingsPath = join(root, "settings.json");
  try {
    return fn({ pluginDir, settingsPath });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("uninstallClaudePlugin", () => {
  test("reports nothingToDo on a fresh system", () => {
    withTempDirs((paths) => {
      const result = uninstallClaudePlugin(paths);
      expect(result.nothingToDo).toBe(true);
      expect(result.removedPluginDir).toBe(false);
      expect(result.removedSettingsEntry).toBe(false);
    });
  });

  test("removes the plugin directory when it exists", () => {
    withTempDirs((paths) => {
      mkdirSync(paths.pluginDir, { recursive: true });
      writeFileSync(join(paths.pluginDir, "config.yaml"), "mode: plugin\n");

      const result = uninstallClaudePlugin(paths);

      expect(result.removedPluginDir).toBe(true);
      expect(result.nothingToDo).toBe(false);
      expect(existsSync(paths.pluginDir)).toBe(false);
    });
  });

  test("removes the entry from settings.json", () => {
    withTempDirs((paths) => {
      writeFileSync(
        paths.settingsPath,
        JSON.stringify(
          {
            theme: "dark",
            enabledPlugins: {
              "memory-engine": true,
              "other-plugin": true,
            },
          },
          null,
          2,
        ),
      );

      const result = uninstallClaudePlugin(paths);

      expect(result.removedSettingsEntry).toBe(true);
      const after = JSON.parse(readFileSync(paths.settingsPath, "utf-8"));
      expect(after.enabledPlugins).toEqual({ "other-plugin": true });
      // Other settings preserved
      expect(after.theme).toBe("dark");
    });
  });

  test("removes both plugin dir and settings entry", () => {
    withTempDirs((paths) => {
      mkdirSync(paths.pluginDir, { recursive: true });
      writeFileSync(
        paths.settingsPath,
        JSON.stringify({ enabledPlugins: { "memory-engine": true } }, null, 2),
      );

      const result = uninstallClaudePlugin(paths);

      expect(result.removedPluginDir).toBe(true);
      expect(result.removedSettingsEntry).toBe(true);
      expect(result.nothingToDo).toBe(false);
    });
  });

  test("is idempotent — second call is a no-op", () => {
    withTempDirs((paths) => {
      mkdirSync(paths.pluginDir, { recursive: true });
      writeFileSync(
        paths.settingsPath,
        JSON.stringify({ enabledPlugins: { "memory-engine": true } }, null, 2),
      );

      uninstallClaudePlugin(paths);
      const second = uninstallClaudePlugin(paths);

      expect(second.nothingToDo).toBe(true);
      expect(second.removedPluginDir).toBe(false);
      expect(second.removedSettingsEntry).toBe(false);
    });
  });

  test("tolerates malformed settings.json", () => {
    withTempDirs((paths) => {
      writeFileSync(paths.settingsPath, "{ not valid json");

      const result = uninstallClaudePlugin(paths);

      // Should not throw; settings entry not removed since we couldn't parse
      expect(result.removedSettingsEntry).toBe(false);
      // File should be untouched
      expect(readFileSync(paths.settingsPath, "utf-8")).toBe(
        "{ not valid json",
      );
    });
  });

  test("does not touch settings.json when plugin is not enabled", () => {
    withTempDirs((paths) => {
      const original = JSON.stringify(
        { enabledPlugins: { "other-plugin": true } },
        null,
        2,
      );
      writeFileSync(paths.settingsPath, original);

      const result = uninstallClaudePlugin(paths);

      expect(result.removedSettingsEntry).toBe(false);
      // File should be byte-identical (no rewrite)
      expect(readFileSync(paths.settingsPath, "utf-8")).toBe(original);
    });
  });

  test("handles settings.json without enabledPlugins field", () => {
    withTempDirs((paths) => {
      writeFileSync(
        paths.settingsPath,
        JSON.stringify({ theme: "dark" }, null, 2),
      );

      const result = uninstallClaudePlugin(paths);

      expect(result.removedSettingsEntry).toBe(false);
      expect(result.nothingToDo).toBe(true);
    });
  });
});
