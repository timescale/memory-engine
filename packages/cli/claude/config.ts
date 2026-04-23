/**
 * Shared config, types, and paths for the Claude Code plugin integration.
 *
 * Used by:
 *   - me claude install (wizard writes config.yaml)
 *   - me claude hook    (reads config.yaml, creates memories)
 *   - me claude uninstall (removes plugin dir, updates settings)
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

// =============================================================================
// Paths
// =============================================================================

export const PLUGIN_DIR = join(
  homedir(),
  ".claude",
  "plugins",
  "memory-engine",
);
export const CONFIG_FILENAME = "config.yaml";
export const CONFIG_PATH = join(PLUGIN_DIR, CONFIG_FILENAME);
export const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
export const PLUGIN_NAME = "memory-engine";

// =============================================================================
// Config
// =============================================================================

export type PluginMode = "plugin" | "mcp-only";

export interface PluginConfig {
  server: string;
  engine: string;
  api_key: string;
  tree_prefix: string;
  mode: PluginMode;
  installed_at?: string;
  installed_by?: string;
}

/**
 * Read and validate config.yaml from a plugin directory.
 *
 * Throws on missing, unreadable, or invalid config.
 */
export function readPluginConfig(pluginDir: string): PluginConfig {
  const path = join(pluginDir, CONFIG_FILENAME);

  if (!existsSync(path)) {
    throw new Error(`Plugin config not found: ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(
      `Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid config in ${path}: expected object`);
  }

  const cfg = parsed as Record<string, unknown>;
  const required = ["server", "engine", "api_key", "tree_prefix", "mode"];
  for (const field of required) {
    if (typeof cfg[field] !== "string") {
      throw new Error(
        `Invalid config in ${path}: missing or non-string '${field}'`,
      );
    }
  }

  if (cfg.mode !== "plugin" && cfg.mode !== "mcp-only") {
    throw new Error(
      `Invalid config in ${path}: mode must be 'plugin' or 'mcp-only'`,
    );
  }

  return {
    server: cfg.server as string,
    engine: cfg.engine as string,
    api_key: cfg.api_key as string,
    tree_prefix: cfg.tree_prefix as string,
    mode: cfg.mode,
    installed_at:
      typeof cfg.installed_at === "string" ? cfg.installed_at : undefined,
    installed_by:
      typeof cfg.installed_by === "string" ? cfg.installed_by : undefined,
  };
}
