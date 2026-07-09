/**
 * The harness-injected environment contract (HARNESS_DESIGN.md, "Mechanism for
 * (c): the harness-injected environment").
 *
 * Every harness adapter (Claude's SessionStart hook, opencode's `shell.env`
 * plugin hook, and — PR 2 — Codex/Gemini's PreToolUse/BeforeTool rewrites)
 * injects the same four env vars into every shell command a harness runs, so a
 * plain `me` invocation from an agent's tool shell always resolves the right
 * project and always runs as the configured agent:
 *
 *   - `ME_INJECT_V`    liveness + version marker (what the failsafe and
 *                       `me doctor` key on)
 *   - `AI_AGENT`        identity, per the `@vercel/detect-agent` convention —
 *                       names the *initiating* harness
 *   - `ME_AS_AGENT`     always the literal `.me` sentinel — activation
 *   - `ME_PROJECT_DIR`  the session's project dir, verbatim — the discovery
 *                       anchor `me` walks up from at invocation time
 *
 * This module centralizes the names + version so adapters and the
 * failsafe/detection code can't drift, plus a shared shell-file writer for
 * adapters (like Claude's) that inject via a sourced env file rather than an
 * in-process object (opencode, Codex, Gemini mutate a JS/JSON value directly
 * and don't need the block-text form).
 *
 * The single gate every adapter must apply is **first-writer-wins**: when a
 * live `ME_INJECT_V` is already in the *adapter's own* inherited env, emit
 * nothing — the process was itself spawned inside another session's contract
 * (a nested harness), and clobbering it would flip which project/agent
 * governs the inner session. See {@link isInjectionLive}.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Liveness + version marker env var name. */
export const ME_INJECT_V_VAR = "ME_INJECT_V";
/** Harness-identity env var name (the `@vercel/detect-agent` convention). */
export const AI_AGENT_VAR = "AI_AGENT";
/** Activation env var name — always set to {@link HARNESS_AS_AGENT_SENTINEL}. */
export const ME_AS_AGENT_VAR = "ME_AS_AGENT";
/** Discovery-anchor env var name. */
export const ME_PROJECT_DIR_VAR = "ME_PROJECT_DIR";

/**
 * The `.me` sentinel value every adapter injects for `ME_AS_AGENT` — resolved
 * by `resolveAsAgentFor`/`resolveHarnessAgent` in credentials.ts against
 * config scope (project `agent:` → global `agent:` → hard error). Duplicated
 * here (rather than imported from credentials.ts) so this module stays a leaf
 * dependency generated-source renderers (like the opencode plugin template)
 * can pull constants from without dragging in credential/session machinery.
 */
export const HARNESS_AS_AGENT_SENTINEL = ".me";

/**
 * Bump when the injected contract's shape changes in a way `me` needs to key
 * on (new required var, changed semantics). The failsafe and `me doctor` only
 * check *presence*, not the exact value, so adding a var is not a breaking
 * bump — reserved for the day it needs to be.
 */
export const ME_INJECT_VERSION = "1";

/**
 * Whether a live injected contract is already present in `env`. Requires the
 * liveness marker AND the two functionally load-bearing vars (activation,
 * discovery) to all be present — not just `ME_INJECT_V` alone. A partially
 * injected or stale env (e.g. `ME_INJECT_V` surviving in a subshell while
 * `ME_AS_AGENT`/`ME_PROJECT_DIR` didn't) must not read as "live": that would
 * let the failsafe wave it through, and let first-writer-wins skip an
 * adapter that should have run. `AI_AGENT` is excluded on purpose — it's
 * identity/observability only, never consulted for activation or discovery.
 */
export function isInjectionLive(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env[ME_INJECT_V_VAR] && env[ME_AS_AGENT_VAR] && env[ME_PROJECT_DIR_VAR],
  );
}

/**
 * The four contract vars for a given harness + project dir, ready to inject
 * (as env, or rendered into shell text via {@link renderContractBlock}).
 */
export function buildContractVars(
  harness: string,
  projectDir: string,
): Record<string, string> {
  return {
    [ME_INJECT_V_VAR]: ME_INJECT_VERSION,
    [AI_AGENT_VAR]: harness,
    [ME_AS_AGENT_VAR]: HARNESS_AS_AGENT_SENTINEL,
    [ME_PROJECT_DIR_VAR]: projectDir,
  };
}

const BLOCK_START = "# >>> memory-engine (harness contract) >>>";
const BLOCK_END = "# <<< memory-engine (harness contract) <<<";

/** Shell-quote a value for a POSIX `export NAME="value"` line. */
function shellQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
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
