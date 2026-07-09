/**
 * `.claude/settings.json` remover — Claude Code's committed project settings.
 *
 * Historically `me project init` wrote the project agent into this file's
 * `"env"` map (`ME_AS_AGENT=<agent name>`) because the Bash tool runs `me`
 * from arbitrary cwds where a `.me` walk-up wouldn't resolve the project's
 * agent. That's superseded by agent-by-config: the SessionStart hook
 * (`me claude env`) now injects `ME_PROJECT_DIR` (the
 * discovery anchor) and `ME_AS_AGENT=.me` (the ordinary sentinel) into every
 * Bash command's env, so the same resolution works from any cwd without a
 * baked-in literal name. `me project init` now only *removes* a stale
 * `ME_AS_AGENT` pin (see {@link removeClaudeSettingsEnvKey}) rather than
 * writing one — a leftover literal name would otherwise silently override
 * the injected sentinel's config-scope resolution.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CLAUDE_DIRNAME = ".claude";
const SETTINGS_FILENAME = "settings.json";

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
