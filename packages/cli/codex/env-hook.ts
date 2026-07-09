/**
 * Codex CLI PreToolUse hook payload → env-injecting command rewrite.
 *
 * Codex's PreToolUse hook receives the tool call on stdin and may return a
 * rewritten input. For the "Bash" tool this lets us prepend an
 * `export …; ` prefix (see harness-contract.ts) to the command string, so a
 * plain `me` invocation inside it resolves the right project
 * (`ME_PROJECT_DIR`, the session `cwd`, verbatim) and runs as the configured
 * agent (`ME_AS_AGENT=.me`).
 *
 * Vendored payload shape (confirmed against developers.openai.com/codex/hooks):
 * ```json
 * {
 *   "session_id": "...", "cwd": "/repo", "hook_event_name": "PreToolUse",
 *   "tool_name": "Bash", "tool_use_id": "...",
 *   "tool_input": { "command": "npm test" }
 * }
 * ```
 * Rewrite response:
 * ```json
 * {
 *   "hookSpecificOutput": {
 *     "hookEventName": "PreToolUse",
 *     "permissionDecision": "allow",
 *     "updatedInput": { "command": "export …; npm test" }
 *   }
 * }
 * ```
 *
 * Deliberately narrow: anything that doesn't match — not an object, missing
 * `cwd`, a `tool_name` other than "Bash", or a non-string `tool_input.command`
 * — is either an EXPECTED non-match (a non-Bash tool call: no output, no log)
 * or an UNRECOGNIZED shape (an object missing the fields we expect at all: no
 * output, but flagged for {@link logUnrecognizedPayloadShape} so a future
 * `me doctor` can surface "Codex changed its payload — upgrade `me`").
 */
import {
  buildContractVars,
  isInjectionLive,
  renderExportPrefix,
} from "../harness-contract.ts";

/** The Codex tool name we rewrite (a shell execution). */
const BASH_TOOL_NAME = "Bash";

/** The harness identity we inject (`AI_AGENT`). */
const HARNESS_NAME = "codex";

export interface CodexEnvHookResult {
  /** JSON to print to stdout — undefined means fail-open, print nothing. */
  output?: Record<string, unknown>;
  /** Set when the payload didn't match anything we understand (worth logging). */
  unrecognizedShape?: boolean;
}

/** Loosely-typed view of the fields we read from the payload. */
interface RawPreToolUsePayload {
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
}

/**
 * Pure decision core (no I/O): given the parsed stdin payload and the
 * process env, decide what `me codex env-hook` prints to stdout.
 */
export function buildCodexEnvHookOutput(
  payload: unknown,
  env: NodeJS.ProcessEnv,
): CodexEnvHookResult {
  // First-writer-wins: a live contract already in THIS hook process's env
  // means Codex itself was launched inside another session's contract (a
  // nested harness) — leave it untouched.
  if (isInjectionLive(env)) return {};

  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return { unrecognizedShape: true };
  }
  const p = payload as RawPreToolUsePayload;
  if (typeof p.cwd !== "string" || typeof p.tool_name !== "string") {
    return { unrecognizedShape: true };
  }
  if (p.tool_name !== BASH_TOOL_NAME) return {}; // expected: not a shell exec

  const toolInput = p.tool_input;
  if (
    toolInput === null ||
    typeof toolInput !== "object" ||
    Array.isArray(toolInput) ||
    typeof (toolInput as { command?: unknown }).command !== "string"
  ) {
    return { unrecognizedShape: true };
  }
  const command = (toolInput as { command: string }).command;

  const prefix = renderExportPrefix(buildContractVars(HARNESS_NAME, p.cwd));
  return {
    output: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: `${prefix}${command}` },
      },
    },
  };
}
