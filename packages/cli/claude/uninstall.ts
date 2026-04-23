/**
 * Uninstall logic for the Memory Engine Claude Code plugin.
 *
 * Used by:
 *   - me claude uninstall (standalone command)
 *   - me claude install   (Step 3: existing-install detection offers uninstall)
 *
 * Idempotent — safe to call when nothing is installed. Returns a status
 * object describing what was removed so callers can emit appropriate
 * messages. Does NOT delete API keys or captured memories.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  PLUGIN_DIR as DEFAULT_PLUGIN_DIR,
  SETTINGS_PATH as DEFAULT_SETTINGS_PATH,
  PLUGIN_NAME,
} from "./config.ts";

export interface UninstallResult {
  /** Whether the plugin directory existed and was removed. */
  removedPluginDir: boolean;
  /** Whether the plugin was enabled in settings.json and is now removed. */
  removedSettingsEntry: boolean;
  /** True if nothing was found to remove (fresh system). */
  nothingToDo: boolean;
}

export interface UninstallPaths {
  pluginDir?: string;
  settingsPath?: string;
}

/**
 * Remove the plugin directory and disable it in Claude's settings.json.
 *
 * Silently tolerates missing files, malformed settings, and partial state
 * so that re-running `me claude uninstall` is always safe.
 */
export function uninstallClaudePlugin(
  paths: UninstallPaths = {},
): UninstallResult {
  const pluginDir = paths.pluginDir ?? DEFAULT_PLUGIN_DIR;
  const settingsPath = paths.settingsPath ?? DEFAULT_SETTINGS_PATH;

  let removedPluginDir = false;
  let removedSettingsEntry = false;

  // Remove the plugin directory
  if (existsSync(pluginDir)) {
    rmSync(pluginDir, { recursive: true, force: true });
    removedPluginDir = true;
  }

  // Remove the entry from settings.json
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(raw) as Record<string, unknown>;
      const enabled = settings.enabledPlugins;

      if (enabled && typeof enabled === "object" && !Array.isArray(enabled)) {
        const map = enabled as Record<string, unknown>;
        if (PLUGIN_NAME in map) {
          delete map[PLUGIN_NAME];
          writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
          removedSettingsEntry = true;
        }
      }
    } catch {
      // Malformed settings — leave untouched.
    }
  }

  return {
    removedPluginDir,
    removedSettingsEntry,
    nothingToDo: !removedPluginDir && !removedSettingsEntry,
  };
}
