/**
 * Claude Code capture hook — config resolution + event shape.
 *
 * Capture itself is the import path: the hook reads the session transcript and
 * runs it through `importTranscriptFile` (packages/cli/importers), so live
 * captures and `me import` produce identical memories (tree, ids, `source_*`
 * metadata). This module only resolves the runtime config (bearer + space +
 * tree root + content mode) and types the slice of the hook event payload we
 * read. The orchestration lives in `commands/claude.ts` (`me claude hook`).
 */
import {
  DEFAULT_SESSIONS_NODE_NAME,
  DEFAULT_TREE_ROOT,
} from "../importers/index.ts";

export const DEFAULT_SERVER = "https://api.memory.build";

/** Per-project sessions leaf, shared with `me import`. */
export const SESSIONS_NODE = DEFAULT_SESSIONS_NODE_NAME;

/**
 * Hook events the plugin registers. Both drive a full transcript import (Stop
 * per turn; SessionEnd as a final flush) — idempotent, so re-importing is a
 * no-op for already-captured messages.
 */
export const HOOK_EVENT_NAMES = ["stop", "session-end"] as const;
export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/** The slice of a Claude Code hook event payload the capture hook reads. */
export interface HookEvent {
  session_id?: string;
  cwd?: string;
  /** Path to the session transcript JSONL (present on Stop / SessionEnd). */
  transcript_path?: string;
  hook_event_name?: string;
}

/** Resolved hook config: where + how to write captured memories. */
export interface HookConfig {
  /** Memory Engine server URL. */
  server: string;
  /**
   * Bearer for the memory endpoint: the plugin's api key (sensitive userConfig)
   * when set, else the user's `me login` session token.
   */
  token: string;
  /** Active space slug (X-Me-Space). */
  space: string;
  /** Tree root; captures nest as `<treeRoot>.<project>.agent_sessions`. */
  treeRoot: string;
  /** content_mode=full_transcript → also store reasoning + tool calls/results. */
  fullTranscript: boolean;
}

/** Credentials the hook falls back to when the plugin's api_key is unset. */
export interface HookFallbackCreds {
  apiKey?: string;
  sessionToken?: string;
  activeSpace?: string;
  server?: string;
}

/**
 * Treat unset / empty / unsubstituted-placeholder values as missing. Claude Code
 * may substitute an empty string (or leave the literal `${user_config.x}`) for an
 * optional userConfig field the user left blank.
 */
function blank(v: string | undefined): boolean {
  return !v || /^\$\{.*\}$/.test(v);
}

/**
 * Resolve the hook config. The bearer is the plugin's `api_key`
 * (`CLAUDE_PLUGIN_OPTION_API_KEY`) when set; otherwise it falls back to the
 * user's `me login` session (passed in via `creds`, so this stays pure/testable).
 * The space comes from the plugin config, else the caller's active space.
 * Returns null when no bearer or no space is available.
 */
export function resolveHookConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  creds: HookFallbackCreds = {},
): HookConfig | null {
  const pluginKey = blank(env.CLAUDE_PLUGIN_OPTION_API_KEY)
    ? undefined
    : env.CLAUDE_PLUGIN_OPTION_API_KEY;
  // Bearer precedence mirrors `me mcp`: plugin key > ME_API_KEY > login session.
  const token = pluginKey ?? creds.apiKey ?? creds.sessionToken;
  if (!token) return null;

  // Space: plugin config, else the active space. Required either way.
  const space = blank(env.CLAUDE_PLUGIN_OPTION_SPACE)
    ? creds.activeSpace
    : env.CLAUDE_PLUGIN_OPTION_SPACE;
  if (!space) return null;

  const server = blank(env.CLAUDE_PLUGIN_OPTION_SERVER)
    ? (creds.server ?? DEFAULT_SERVER)
    : (env.CLAUDE_PLUGIN_OPTION_SERVER as string);

  const treeRoot = blank(env.CLAUDE_PLUGIN_OPTION_TREE_ROOT)
    ? DEFAULT_TREE_ROOT
    : (env.CLAUDE_PLUGIN_OPTION_TREE_ROOT as string);

  const fullTranscript =
    (env.CLAUDE_PLUGIN_OPTION_CONTENT_MODE ?? "").toLowerCase() ===
    "full_transcript";

  return { server, token, space, treeRoot, fullTranscript };
}
