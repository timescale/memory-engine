/**
 * Claude Code hook event parsing and memory capture.
 *
 * Pure functions for event parsing and metadata construction are testable in
 * isolation. The `captureHookEvent` entry point handles memory creation via the
 * memory client. The project label is derived by the shared `resolveProjectSlug`
 * (the same logic the import tool uses) so live + imported sessions for a repo
 * share one project node.
 */

import { CLIENT_VERSION } from "../../../version";
import { createMemoryClient, type MemoryClient } from "../client.ts";
import { resolveProjectSlug } from "../importers/slug.ts";

// =============================================================================
// Hook config (derived at runtime from CLAUDE_PLUGIN_OPTION_* env vars)
// =============================================================================

export interface HookConfig {
  /** Memory Engine server URL. */
  server: string;
  /**
   * Bearer for the memory endpoint: the plugin's api key (sensitive userConfig)
   * when set, else the user's `me login` session token. Both authenticate the
   * memory endpoint.
   */
  token: string;
  /** Active space slug (X-Me-Space). */
  space: string;
  /**
   * Tree root under which captures are nested as
   * `<treeRoot>.<project>.<sessions-node>` — the same shape the import tool
   * writes, so live captures and imported sessions share one node per project.
   */
  treeRoot: string;
}

// =============================================================================
// Event types
// =============================================================================

export type HookEventName = "user-prompt-submit" | "stop";

export const HOOK_EVENT_NAMES: HookEventName[] = ["user-prompt-submit", "stop"];

/** Fields common to all Claude Code hook events. */
interface HookEventBase {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  hook_event_name?: string;
}

export interface UserPromptSubmitEvent extends HookEventBase {
  prompt: string;
}

export interface StopEvent extends HookEventBase {
  last_assistant_message?: string | null;
  stop_hook_active?: boolean;
}

export type HookEvent = UserPromptSubmitEvent | StopEvent;

// =============================================================================
// Pure helpers (testable)
// =============================================================================

/**
 * Extract the memory content from a hook event.
 *
 * Returns null if the event has no content to capture.
 */
export function extractContent(
  event: HookEvent,
  eventName: HookEventName,
): string | null {
  if (eventName === "user-prompt-submit") {
    const prompt = (event as UserPromptSubmitEvent).prompt;
    if (typeof prompt !== "string") return null;
    const trimmed = prompt.trim();
    return trimmed.length > 0 ? prompt : null;
  }

  if (eventName === "stop") {
    const msg = (event as StopEvent).last_assistant_message;
    if (typeof msg !== "string") return null;
    const trimmed = msg.trim();
    return trimmed.length > 0 ? msg : null;
  }

  return null;
}

/** Map an event name to the message role (`source_message_role`). */
export function messageRoleForEvent(
  eventName: HookEventName,
): "user" | "assistant" {
  return eventName === "user-prompt-submit" ? "user" : "assistant";
}

/**
 * Build the metadata for a captured memory. Uses the same `source_*` schema as
 * the import tool (see buildMeta in packages/cli/importers/index.ts) so live
 * captures and imported sessions co-located in a project node are uniformly
 * queryable. `type` is the constant `agent_session`; the prompt/response
 * distinction lives in `source_message_role`.
 */
export function buildMeta(
  event: HookEvent,
  eventName: HookEventName,
  project: string,
  gitRepo?: string,
): Record<string, string> {
  const meta: Record<string, string> = {
    type: "agent_session",
    source_tool: "claude-code",
    source_session_id: event.session_id,
    source_message_role: messageRoleForEvent(eventName),
    source_project_slug: project,
    source_cwd: event.cwd,
    content_mode: "default",
    me_version: CLIENT_VERSION,
  };
  if (gitRepo) meta.source_git_repo = gitRepo;
  return meta;
}

// =============================================================================
// Config resolution from environment
// =============================================================================

export const DEFAULT_SERVER = "https://api.memory.build";
// Captures nest as `<treeRoot>.<project>.<SESSIONS_NODE>`, identical to the
// import tool's default layout (see DEFAULT_TREE_ROOT / DEFAULT_SESSIONS_NODE_NAME
// in packages/cli/commands/import.ts), so live + imported sessions for a project
// land in the same node (distinguished by meta.source). Under `share` so a
// session-authenticated user (owner@share, not arbitrary top-level paths) can
// write here.
export const DEFAULT_TREE_ROOT = "share.projects";
// Fixed per-project leaf, matching the import tool's --sessions-node-name default.
const SESSIONS_NODE = "agent_sessions";

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
 * Resolve the hook config. The bearer is the plugin's `api_key` (sensitive
 * userConfig, delivered via `CLAUDE_PLUGIN_OPTION_API_KEY`) when set; otherwise
 * it falls back to the user's `me login` session (passed in via `creds`, so this
 * function stays pure/testable). The space comes from the plugin config, else the
 * caller's active space. Returns null when no bearer or no space is available.
 *
 * Claude Code delivers `sensitive: true` userConfig values (like api_key) through
 * the same env var mechanism as non-sensitive ones.
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

  // Space: plugin config, else the active space. Required either way (api keys
  // are global, and a session still needs a target space).
  const space = blank(env.CLAUDE_PLUGIN_OPTION_SPACE)
    ? creds.activeSpace
    : env.CLAUDE_PLUGIN_OPTION_SPACE;
  if (!space) return null;

  const server = blank(env.CLAUDE_PLUGIN_OPTION_SERVER)
    ? (creds.server ?? DEFAULT_SERVER)
    : (env.CLAUDE_PLUGIN_OPTION_SERVER as string);

  return {
    token,
    space,
    server,
    treeRoot: env.CLAUDE_PLUGIN_OPTION_TREE_ROOT || DEFAULT_TREE_ROOT,
  };
}

// =============================================================================
// Capture entry point
// =============================================================================

export interface CaptureResult {
  status: "captured" | "skipped";
  reason?: string;
  memoryId?: string;
}

export interface CaptureOptions {
  /** Override the client (for tests). */
  client?: MemoryClient;
  /** Override timestamp (for deterministic tests). */
  now?: () => Date;
}

/**
 * Capture a hook event as a memory.
 *
 * Returns immediately if there's no content to capture. Otherwise creates a
 * memory under `<config.treeRoot>.<project>.agent_sessions` with metadata.
 */
export async function captureHookEvent(
  event: HookEvent,
  eventName: HookEventName,
  config: HookConfig,
  opts: CaptureOptions = {},
): Promise<CaptureResult> {
  const content = extractContent(event, eventName);
  if (content === null) {
    return { status: "skipped", reason: "empty content" };
  }

  const { slug: project, gitRemote } = await resolveProjectSlug(event.cwd);
  const meta = buildMeta(event, eventName, project, gitRemote);
  const now = (opts.now ?? (() => new Date()))();

  const client =
    opts.client ??
    createMemoryClient({
      url: config.server,
      token: config.token,
      space: config.space,
    });

  // Nest by project under the configured root, with a fixed sessions leaf —
  // `<treeRoot>.<project>.<SESSIONS_NODE>` — matching the import tool's layout.
  const result = await client.memory.create({
    content,
    tree: `${config.treeRoot}.${project}.${SESSIONS_NODE}`,
    meta,
    temporal: { start: now.toISOString() },
  });

  return { status: "captured", memoryId: result.id };
}
