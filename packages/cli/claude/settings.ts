/**
 * `.claude/settings.json` writer — Claude Code's committed project settings.
 *
 * `me project init` writes the project agent into this file's `"env"` map
 * (`ME_AS_AGENT=<agent name>`) so *everything* Claude runs in the project —
 * including ad-hoc `me` calls from its Bash tool — acts as the project's
 * agent. The value is the **literal agent name**, not the `.me` sentinel: the
 * Bash tool runs `me` from arbitrary cwds (`/tmp`, `$HOME`, …) where a `.me`
 * walk-up wouldn't find the project config, so the sentinel would fail to
 * resolve there. The same name is written to `.me/config.yaml` `agent:`
 * (which drives the sentinel for `me` run *inside* the project) — the wizard
 * writes both together.
 *
 * Personal overrides belong in Claude's own `settings.local.json`; this
 * module only touches the committed file, merging into `env` and preserving
 * every other key.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CLAUDE_DIRNAME = ".claude";
const SETTINGS_FILENAME = "settings.json";

/**
 * Merge `env` entries into `<projectRoot>/.claude/settings.json`'s `"env"`
 * map, creating the directory/file when absent and preserving all other keys
 * (and other env entries). Plain JSON — no comments to keep. Throws on a
 * malformed existing file rather than silently replacing it. Returns the path
 * written.
 */
export function writeClaudeSettingsEnv(
  projectRoot: string,
  env: Record<string, string>,
): string {
  const dir = join(projectRoot, CLAUDE_DIRNAME);
  const path = join(dir, SETTINGS_FILENAME);

  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8"));
    } catch (error) {
      throw new Error(
        `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error(`${path} must contain a JSON object`);
    }
    settings = parsed as Record<string, unknown>;
  }

  const existingEnv =
    settings.env !== null &&
    typeof settings.env === "object" &&
    !Array.isArray(settings.env)
      ? (settings.env as Record<string, unknown>)
      : {};
  settings.env = { ...existingEnv, ...env };

  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return path;
}
