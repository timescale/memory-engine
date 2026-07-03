/**
 * Claude Code capture hook — config resolution + event shape.
 *
 * Capture itself is the import path: the hook reads the session transcript and
 * runs it through `importTranscriptFile` (packages/cli/importers), so live
 * captures and `me import claude` produce identical memories (tree, ids, `source_*`
 * metadata). This module only resolves the runtime config (bearer + space +
 * tree root + content mode) and types the slice of the hook event payload we
 * read. The orchestration lives in `commands/claude.ts` (`me claude hook`).
 *
 * The hook ships INERT: capture must be turned on — via the machine-wide
 * setting (the `me claude install` prompt) or a project `.me/config.yaml`
 * `capture: true` — before anything is written (see
 * {@link resolveCaptureEnabled}). Once on, captures default to the PRIVATE
 * `~/projects/<slug>` tree unless a project pins its own `tree`.
 */
import {
  DEFAULT_PRIVATE_TREE_ROOT,
  DEFAULT_SESSIONS_NODE_NAME,
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
  /**
   * Tree root (parent + slug layout); captures nest as
   * `<treeRoot>.<project>.agent_sessions`. Always the private `~/projects` —
   * tree routing has exactly two levels: the `.me` `tree` (below), else this
   * default. There is deliberately NO plugin-level tree pin (the retired
   * `tree_root` userConfig): committed project config is the one routing
   * surface, so a forgotten plugin value can never override a repo's `.me`.
   */
  treeRoot: string;
  /**
   * The full project tree from a `.me/config.yaml` in the session's project, if
   * any. When set, captures nest directly under it (`<projectTree>.agent_sessions`,
   * NO slug) — it takes precedence over `<treeRoot>.<slug>`.
   */
  projectTree?: string;
  /** content_mode=full_transcript → also store reasoning + tool calls/results. */
  fullTranscript: boolean;
  /**
   * Act-as-agent target (X-Me-As-Agent) — captures then write as that agent,
   * constrained to its access. Undefined when not in agent mode.
   */
  asAgent?: string;
}

/** Credentials the hook falls back to when the plugin's api_key is unset. */
export interface HookFallbackCreds {
  apiKey?: string;
  /** Whether the user has a `me login` session to fall back to. */
  loggedIn?: boolean;
  activeSpace?: string;
  server?: string;
  /** Act-as-agent target resolved from `--as-agent` / `ME_AS_AGENT`. */
  asAgent?: string;
  /**
   * The resolved capture setting (`ResolvedCredentials.captureEnabled`):
   * project `.me` `capture` > machine-wide config > off.
   */
  captureEnabled?: boolean;
}

/**
 * The session project's `.me/config.yaml` (resolved from the session cwd), when
 * present. Provides server/space fallbacks, the full project `tree`, and the
 * project's `capture` opt-in/out.
 */
export interface HookProjectConfig {
  server?: string;
  space?: string;
  tree?: string;
  capture?: boolean;
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
 * Whether the hook should capture at all. The hook ships inert; capture is on
 * only when, highest-first:
 *
 *   1. the session project's `.me/config.yaml` pins `capture` (true → on even
 *      if the user never opted in globally — a committed team config wins;
 *      false → off, a per-project opt-out), else
 *   2. the machine-wide setting (`creds.captureEnabled`, written by the
 *      `me claude install` prompt), else
 *   3. OFF.
 *
 * Exception: a plugin-pinned api key (`CLAUDE_PLUGIN_OPTION_API_KEY`) is a
 * headless install — the operator explicitly configured the plugin to capture
 * with a fixed key/space, and the machine-wide opt-in (a per-user setting)
 * doesn't apply. A project `capture: false` still opts the project out.
 */
export function resolveCaptureEnabled(
  env: NodeJS.ProcessEnv = process.env,
  creds: HookFallbackCreds = {},
  project: HookProjectConfig = {},
): boolean {
  if (project.capture !== undefined) return project.capture;
  if (!blank(env.CLAUDE_PLUGIN_OPTION_API_KEY)) return true;
  return creds.captureEnabled ?? false;
}

/**
 * Resolve the hook config. The bearer is the plugin's `api_key`
 * (`CLAUDE_PLUGIN_OPTION_API_KEY`) when set; otherwise it falls back to the
 * user's `me login` session (passed in via `creds`, so this stays pure/testable).
 *
 * Precedence for server/space: an explicit plugin-pinned value (headless
 * install) > the session project's `.me/config.yaml` (`project`) > the
 * caller's fallback creds. The TREE has no plugin pin (the `tree_root`
 * userConfig is retired — a plugin-level value would silently override
 * committed project config): the `.me` `tree` (the full project node,
 * no-slug layout) wins, else the private `~/projects` parent+slug default —
 * the shared `share.projects` layout is a `.me` opt-in, never a default.
 * Returns null when no bearer or no space is available.
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

  const fullTranscript =
    (env.CLAUDE_PLUGIN_OPTION_CONTENT_MODE ?? "").toLowerCase() ===
    "full_transcript";

  return {
    server,
    apiKey,
    space,
    treeRoot: DEFAULT_PRIVATE_TREE_ROOT,
    projectTree: project.tree,
    fullTranscript,
    asAgent: creds.asAgent,
  };
}
