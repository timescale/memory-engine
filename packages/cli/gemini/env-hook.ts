/**
 * Gemini CLI BeforeTool hook payload → env-injecting command rewrite
 * (HARNESS_DESIGN.md, PR 2). Structural twin of ../codex/env-hook.ts —
 * different payload/response field names, same decision shape.
 *
 * Vendored payload shape (confirmed against geminicli.com/docs/hooks/reference):
 * ```json
 * {
 *   "session_id": "...", "cwd": "/repo", "hook_event_name": "BeforeTool",
 *   "tool_name": "run_shell_command",
 *   "tool_input": { "command": "npm test" }
 * }
 * ```
 * Rewrite response — `hookSpecificOutput.tool_input` shallow-merges over the
 * model's original arguments:
 * ```json
 * { "hookSpecificOutput": { "tool_input": { "command": "export …; npm test" } } }
 * ```
 *
 * Same narrowing as the Codex hook: a `tool_name` other than
 * "run_shell_command" is an EXPECTED non-match (no output, no log); an
 * object missing the fields we expect at all is an UNRECOGNIZED shape (no
 * output, but {@link GeminiEnvHookResult.unrecognizedShape} is set so the
 * caller can log it).
 */
import {
  buildContractVars,
  isInjectionLive,
  renderExportPrefix,
} from "../harness-contract.ts";

/** The Gemini tool name we rewrite (a shell execution). */
const SHELL_TOOL_NAME = "run_shell_command";

/** The harness identity we inject (`AI_AGENT`) — matches the design's own
 * convention, distinct from `@vercel/detect-agent`'s native-marker "gemini"
 * (see harness-detect.ts's naming note). */
const HARNESS_NAME = "gemini-cli";

export interface GeminiEnvHookResult {
  /** JSON to print to stdout — undefined means fail-open, print nothing. */
  output?: Record<string, unknown>;
  /** Set when the payload didn't match anything we understand (worth logging). */
  unrecognizedShape?: boolean;
}

/** Loosely-typed view of the fields we read from the payload. */
interface RawBeforeToolPayload {
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
}

/**
 * Pure decision core (no I/O): given the parsed stdin payload and the
 * process env, decide what `me gemini env-hook` prints to stdout.
 */
export function buildGeminiEnvHookOutput(
  payload: unknown,
  env: NodeJS.ProcessEnv,
): GeminiEnvHookResult {
  // First-writer-wins — see codex/env-hook.ts's identical comment.
  if (isInjectionLive(env)) return {};

  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return { unrecognizedShape: true };
  }
  const p = payload as RawBeforeToolPayload;
  if (typeof p.cwd !== "string" || typeof p.tool_name !== "string") {
    return { unrecognizedShape: true };
  }
  if (p.tool_name !== SHELL_TOOL_NAME) return {}; // expected: not a shell exec

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
        tool_input: { command: `${prefix}${command}` },
      },
    },
  };
}
