/**
 * Claude Code capture hook — config resolution + event shape.
 *
 * Capture itself is the import path: the hook reads the session transcript and
 * runs it through `importTranscriptFile` (packages/cli/importers), so live
 * captures and `me import claude` produce identical memories (tree, ids, `source_*`
 * metadata). This module only resolves the runtime config (bearer + space +
 * tree root + content mode) and types the slice of the hook event payload we
 * read. The orchestration lives in `commands/claude.ts` (`me claude hook`).
 */
import {
  DEFAULT_SESSIONS_NODE_NAME,
  DEFAULT_TREE_ROOT,
} from "../importers/index.ts";

export const DEFAULT_SERVER = "https://api.memory.build";

/** Per-project sessions leaf, shared with `me import claude`. */
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
   * when set, else undefined — meaning use the user's `me login` OAuth session,
   * resolved + refreshed at runtime from the keychain/config by `memoryBearer`.
   */
  apiKey?: string;
  /** Active space slug (X-Me-Space). */
  space: string;
  /** Tree root; captures nest as `<treeRoot>.<project>.agent_sessions`. */
  treeRoot: string;
  /**
   * The full project tree from a `.me/config.yaml` in the session's project, if
   * any. When set, captures nest directly under it (`<projectTree>.agent_sessions`,
   * NO slug) — it takes precedence over `<treeRoot>.<slug>`. A plugin-pinned
   * `tree_root` (headless install) overrides it back to the slug layout.
   */
  projectTree?: string;
  /** content_mode=full_transcript → also store reasoning + tool calls/results. */
  fullTranscript: boolean;
}

/** Credentials the hook falls back to when the plugin's api_key is unset. */
export interface HookFallbackCreds {
  apiKey?: string;
  /** Whether the user has a `me login` session to fall back to. */
  loggedIn?: boolean;
  activeSpace?: string;
  server?: string;
}

/**
 * The session project's `.me/config.yaml` (resolved from the session cwd), when
 * present. Provides server/space fallbacks and the full project `tree`.
 */
export interface HookProjectConfig {
  server?: string;
  space?: string;
  tree?: string;
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
 *
 * Precedence for server/space/tree: an explicit plugin-pinned value (headless
 * install) > the session project's `.me/config.yaml` (`project`) > the caller's
 * fallback creds. The project `.me` `tree` is the full project tree, so when it
 * supplies the tree we set `projectTree` (no-slug layout); a plugin-pinned
 * `tree_root` overrides back to `<treeRoot>.<slug>`. Returns null when no bearer
 * or no space is available.
 */
export function resolveHookConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  creds: HookFallbackCreds = {},
  project: HookProjectConfig = {},
): HookConfig | null {
  const pluginKey = blank(env.CLAUDE_PLUGIN_OPTION_API_KEY)
    ? undefined
    : env.CLAUDE_PLUGIN_OPTION_API_KEY;
  // Bearer precedence mirrors `me mcp`: plugin key > ME_API_KEY, else the login
  // session. An explicit api key is carried through; the session path leaves
  // `apiKey` undefined and is resolved at send time by `memoryBearer`.
  const apiKey = pluginKey ?? creds.apiKey;
  if (!apiKey && !creds.loggedIn) return null;

  // Space: plugin config > project `.me` > the active space. Required either way.
  const space = blank(env.CLAUDE_PLUGIN_OPTION_SPACE)
    ? (project.space ?? creds.activeSpace)
    : env.CLAUDE_PLUGIN_OPTION_SPACE;
  if (!space) return null;

  const server = blank(env.CLAUDE_PLUGIN_OPTION_SERVER)
    ? (project.server ?? creds.server ?? DEFAULT_SERVER)
    : (env.CLAUDE_PLUGIN_OPTION_SERVER as string);

  // A plugin-pinned tree_root (parent+slug) wins; otherwise the project `.me`
  // tree is the full project node (no slug), else the default parent+slug.
  const pinnedTreeRoot = blank(env.CLAUDE_PLUGIN_OPTION_TREE_ROOT)
    ? undefined
    : (env.CLAUDE_PLUGIN_OPTION_TREE_ROOT as string);
  const treeRoot = pinnedTreeRoot ?? DEFAULT_TREE_ROOT;
  const projectTree = pinnedTreeRoot ? undefined : project.tree;

  const fullTranscript =
    (env.CLAUDE_PLUGIN_OPTION_CONTENT_MODE ?? "").toLowerCase() ===
    "full_transcript";

  return { server, apiKey, space, treeRoot, projectTree, fullTranscript };
}
