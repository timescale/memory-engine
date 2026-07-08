/**
 * `.claude/settings.json` writer — Claude Code's committed project settings.
 *
 * Historically `me project init` wrote the project agent into this file's
 * `"env"` map (`ME_AS_AGENT=<agent name>`) because the Bash tool runs `me`
 * from arbitrary cwds where a `.me` walk-up wouldn't resolve the project's
 * agent. That's superseded by agent-by-config (HARNESS_DESIGN.md): the
 * SessionStart hook (`me claude env`) now injects `ME_PROJECT_DIR` (the
 * discovery anchor) and `ME_AS_AGENT=.me` (the ordinary sentinel) into every
 * Bash command's env, so the same resolution works from any cwd without a
 * baked-in literal name. `me project init` now only *removes* a stale
 * `ME_AS_AGENT` pin (see {@link removeClaudeSettingsEnvKey}) rather than
 * writing one — a leftover literal name would otherwise silently override
 * the injected sentinel's config-scope resolution.
 *
 * `writeClaudeSettingsEnv` remains a general-purpose merge-into-`env` writer
 * for anything that still needs to pin a literal value here. Personal
 * overrides belong in Claude's own `settings.local.json`; this module only
 * touches the committed file, merging into `env` and preserving every other
 * key.
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

/**
 * Remove one key from `<projectRoot>/.claude/settings.json`'s `"env"` map,
 * preserving every other key. Returns whether anything was removed —
 * `false` when the file, its `env` map, or the key is absent, or when the
 * file isn't a parseable JSON object (a malformed file is left for the user
 * to fix rather than compounded by a silent rewrite).
 *
 * `me project init` uses this to clean up the `ME_AS_AGENT` pin it used to
 * write before agent-by-config (see the module doc) — a stale literal value
 * would otherwise silently win over the SessionStart hook's injected `.me`
 * sentinel.
 */
export function removeClaudeSettingsEnvKey(
  projectRoot: string,
  key: string,
): boolean {
  const path = join(projectRoot, CLAUDE_DIRNAME, SETTINGS_FILENAME);
  if (!existsSync(path)) return false;

  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return false;
  }
  if (
    settings === null ||
    typeof settings !== "object" ||
    Array.isArray(settings)
  ) {
    return false;
  }
  const record = settings as Record<string, unknown>;
  const env = record.env;
  if (
    env === null ||
    typeof env !== "object" ||
    Array.isArray(env) ||
    !(key in env)
  ) {
    return false;
  }

  const nextEnv = { ...(env as Record<string, unknown>) };
  delete nextEnv[key];
  record.env = nextEnv;
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return true;
}
