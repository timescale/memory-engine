/**
 * The harness-injected environment contract.
 *
 * Every harness adapter (Claude's SessionStart hook, OpenCode's `shell.env`
 * plugin hook, and Codex's command rewrite) injects the same two env
 * vars into every shell command a harness runs, so a plain `me` invocation
 * resolves the right project:
 *
 *   - `AI_AGENT`        inert harness identity metadata
 *   - `ME_PROJECT_DIR`  the session's project dir, verbatim — the discovery
 *                       anchor `me` walks up from at invocation time
 *
 * This module centralizes the names + version so adapters and the
 * generated source renderers cannot drift. Three render forms cover the three
 * injection mechanisms: a marker-delimited shell-file block for adapters
 * that inject via a sourced env file (Claude's `$CLAUDE_ENV_FILE`), an
 * in-process env object for adapters that mutate one directly (opencode's
 * `shell.env` hook), and a single-line `export …; ` command prefix for
 * adapters that rewrite a command STRING rather than touch env at all
 * (Codex's PreToolUse rewrite).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Harness-identity env var name (the `@vercel/detect-agent` convention). */
export const AI_AGENT_VAR = "AI_AGENT";
/** Discovery-anchor env var name. */
export const ME_PROJECT_DIR_VAR = "ME_PROJECT_DIR";

/**
 * The harness metadata vars for a given harness + project dir, ready to inject
 * (as env, or rendered into shell text via {@link renderContractBlock}).
 */
export function buildContractVars(
  harness: string,
  projectDir: string,
): Record<string, string> {
  return {
    [AI_AGENT_VAR]: harness,
    [ME_PROJECT_DIR_VAR]: projectDir,
  };
}

const BLOCK_START = "# >>> memory-engine (harness contract) >>>";
const BLOCK_END = "# <<< memory-engine (harness contract) <<<";

/** Shell-quote a value for a POSIX `export NAME="value"` line. */
function shellQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
}

/**
 * Render `vars` as a single-line `export NAME="value" ...; ` prefix (trailing
 * space, so it reads naturally prepended to a command string) — used by the
 * Codex's rewrite hook, which mutates a tool-input command string rather
 * than a real process env (Claude/opencode inject via
 * {@link upsertContractBlock} / a `shell.env` hook instead).
 */
export function renderExportPrefix(vars: Record<string, string>): string {
  const assignments = Object.entries(vars)
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ");
  return `export ${assignments}; `;
}

/** Render `vars` as a marker-delimited block of POSIX `export` lines. */
export function renderContractBlock(vars: Record<string, string>): string {
  const lines = [
    BLOCK_START,
    ...Object.entries(vars).map(
      ([name, value]) => `export ${name}=${shellQuote(value)}`,
    ),
    BLOCK_END,
  ];
  return lines.join("\n");
}

/**
 * Idempotently upsert the contract block into a sourced shell file (e.g.
 * Claude's `$CLAUDE_ENV_FILE`): replaces a previously-written block in place
 * (a SessionStart hook refires on resume and `/clear`), or appends when none
 * exists yet. Creates the parent directory and file if absent.
 */
export function upsertContractBlock(
  path: string,
  vars: Record<string, string>,
): void {
  const block = renderContractBlock(vars);

  let existing = "";
  try {
    existing = readFileSync(path, "utf-8");
  } catch {
    // Absent — start fresh.
  }

  const startIdx = existing.indexOf(BLOCK_START);
  const endIdx = existing.indexOf(BLOCK_END);
  let next: string;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    next =
      existing.slice(0, startIdx) +
      block +
      existing.slice(endIdx + BLOCK_END.length);
  } else if (existing.length === 0) {
    next = `${block}\n`;
  } else {
    next = existing.endsWith("\n")
      ? `${existing}${block}\n`
      : `${existing}\n${block}\n`;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
}
