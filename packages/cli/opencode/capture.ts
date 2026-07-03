/**
 * OpenCode capture hook — config resolution + event shape.
 *
 * Capture itself is the import path: `me opencode hook` resolves a session id to
 * its storage file and runs it through `importTranscriptFile`
 * (packages/cli/importers), so live captures and `me import opencode` produce
 * identical memories (tree, ids, `source_*` metadata). This module only resolves
 * the runtime config (bearer + space + tree root + content mode) and types the
 * hook event names. The orchestration lives in `commands/opencode.ts`
 * (`me opencode hook`).
 *
 * Unlike the Claude plugin, OpenCode has no declarative userConfig/keychain, so
 * there are no `*_PLUGIN_OPTION_*` env vars: credentials come from the user's
 * `me login` session (or `ME_API_KEY` / `ME_SPACE`, already folded into
 * `resolveCredentials`), and the tree-root / content-mode knobs are passed as
 * flags by our generated plugin.
 */
import type { ResolvedCredentials } from "../credentials.ts";
import {
  DEFAULT_PRIVATE_TREE_ROOT,
  DEFAULT_SESSIONS_NODE_NAME,
} from "../importers/index.ts";

export const DEFAULT_SERVER = "https://api.memory.build";

/** Per-project sessions leaf, shared with `me import opencode`. */
export const SESSIONS_NODE = DEFAULT_SESSIONS_NODE_NAME;

/**
 * Hook events the plugin forwards. `idle` fires each time a session goes idle
 * (the closest analog to Claude's per-turn Stop); `deleted` is a final flush.
 * Both drive a full incremental transcript import — idempotent, so re-importing
 * is a no-op for already-captured messages.
 */
export const HOOK_EVENT_NAMES = ["idle", "deleted"] as const;
export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/** Resolved hook config: where + how to write captured memories. */
export interface HookConfig {
  /** Memory Engine server URL. */
  server: string;
  /**
   * Bearer for the memory endpoint: an explicit api key (`ME_API_KEY`) when set,
   * else undefined — meaning use the user's `me login` OAuth session, resolved +
   * refreshed at runtime from the keychain/config by `memoryBearer`.
   */
  apiKey?: string;
  /** Active space slug (X-Me-Space). */
  space: string;
  /**
   * Tree root — the slug-free parent each project's slug is appended under;
   * captures nest as `<treeRoot>.<slug>.agent_sessions`. The machine-wide
   * `tree_root` config override when set, else the private `~/projects`.
   * There is deliberately no per-invocation tree pin (the `--tree-root` hook
   * flag is retired): `.me` config is the one routing surface.
   */
  treeRoot: string;
  /**
   * The full project TREE from a `.me/config.yaml` in scope, if any. When set,
   * captures nest directly under it (nothing appended).
   */
  tree?: string;
  /** content_mode=full_transcript → also store reasoning + tool calls/results. */
  fullTranscript: boolean;
  /**
   * Act-as-agent target (X-Me-As-Agent) — captures then write as that agent,
   * constrained to its access. Undefined when not in agent mode.
   */
  asAgent?: string;
}

/** The slice of resolved credentials the hook needs. */
export type HookCreds = Pick<
  ResolvedCredentials,
  | "server"
  | "apiKey"
  | "activeSpace"
  | "loggedIn"
  | "tree"
  | "treeRoot"
  | "asAgent"
  | "projectCapture"
>;

/** Optional knobs the plugin/command passes through. */
export interface HookConfigInput {
  fullTranscript?: boolean;
}

/**
 * Whether the hook should capture at all. Installing the generated OpenCode
 * capture plugin (`me opencode init`) is itself the capture opt-in — unlike
 * Claude's bundled always-installed hook — so absent any project preference,
 * capture is ON. A project `.me/config.yaml` `capture: false` still opts the
 * project out (the harness-agnostic per-project switch, e.g. a sensitive repo).
 */
export function captureOptedOut(creds: Pick<HookCreds, "projectCapture">) {
  return creds.projectCapture === false;
}

/**
 * Resolve the hook config from the caller's credentials plus optional flags.
 * The bearer is an explicit api key when set; otherwise it falls back to the
 * user's `me login` session (`apiKey` left undefined, resolved at send time by
 * `memoryBearer`). The space comes from the active space (`ME_SPACE` / config).
 * Returns null when no bearer or no space is available.
 */
export function resolveHookConfig(
  creds: HookCreds,
  input: HookConfigInput = {},
): HookConfig | null {
  // Bearer: an explicit api key, else the login session. Mirrors `me mcp`.
  if (!creds.apiKey && !creds.loggedIn) return null;

  // Space is required either way.
  const space = creds.activeSpace;
  if (!space) return null;

  const server = creds.server || DEFAULT_SERVER;
  // A `.me` project `tree` is the full project node (nothing appended); else
  // the slug nests under the machine-wide `tree_root` override, else under
  // the PRIVATE default (`~/projects/<slug>` — shared layouts are explicit
  // opt-ins).
  const treeRoot = creds.treeRoot ?? DEFAULT_PRIVATE_TREE_ROOT;
  const tree = creds.tree;
  const fullTranscript = input.fullTranscript ?? false;

  return {
    server,
    apiKey: creds.apiKey,
    space,
    treeRoot,
    tree,
    fullTranscript,
    asAgent: creds.asAgent,
  };
}
