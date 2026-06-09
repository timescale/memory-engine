/**
 * Claude Code hook event parsing and memory capture.
 *
 * Pure functions for event parsing, project derivation, and metadata
 * construction are testable in isolation. The `captureHookEvent` entry
 * point handles memory creation via the memory client.
 */

import { CLIENT_VERSION } from "../../../version";
import { createMemoryClient, type MemoryClient } from "../client.ts";

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
  /** Tree path prefix for captured memories (ltree). */
  treePrefix: string;
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

/** Map an event name to the `type` metadata value. */
export function metaTypeForEvent(eventName: HookEventName): string {
  switch (eventName) {
    case "user-prompt-submit":
      return "user_prompt";
    case "stop":
      return "agent_response";
  }
}

/**
 * Normalize a raw string into a single ltree label.
 * Letters, digits, and underscores only; lowercased.
 */
function sanitizeLtreeLabel(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
  return cleaned.length > 0 ? cleaned : "unknown";
}

/**
 * Derive a project label from a cwd.
 *
 * Tries `git remote get-url origin` first; falls back to the basename of
 * the cwd. The result is a single ltree label (sanitized).
 */
export function deriveProject(cwd: string): string {
  try {
    const proc = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode === 0) {
      const url = new TextDecoder().decode(proc.stdout).trim();
      // Extract the last path segment, stripping .git
      // Matches https://github.com/org/repo.git and git@github.com:org/repo.git
      const match = url.match(/[/:]([^/:]+?)(?:\.git)?$/);
      if (match?.[1]) {
        return sanitizeLtreeLabel(match[1]);
      }
    }
  } catch {
    // Fall through to cwd basename
  }

  const parts = cwd.split("/").filter(Boolean);
  const basename = parts[parts.length - 1] ?? "unknown";
  return sanitizeLtreeLabel(basename);
}

/** Build the metadata object for a captured memory. */
export function buildMeta(
  event: HookEvent,
  eventName: HookEventName,
  project: string,
): Record<string, string> {
  return {
    type: metaTypeForEvent(eventName),
    session_id: event.session_id,
    project,
    cwd: event.cwd,
    source: "claude-code",
    me_version: CLIENT_VERSION,
  };
}

// =============================================================================
// Config resolution from environment
// =============================================================================

export const DEFAULT_SERVER = "https://api.memory.build";
// Under `share` so a session-authenticated user (who holds owner@share, not
// access to arbitrary top-level paths) can actually write captures here.
export const DEFAULT_TREE_PREFIX = "share.claude_code.session";

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
    treePrefix: env.CLAUDE_PLUGIN_OPTION_TREE_PREFIX || DEFAULT_TREE_PREFIX,
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
 * Returns immediately if there's no content to capture. Otherwise creates
 * a memory in the engine under `config.treePrefix` with metadata.
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

  const project = deriveProject(event.cwd);
  const meta = buildMeta(event, eventName, project);
  const now = (opts.now ?? (() => new Date()))();

  const client =
    opts.client ??
    createMemoryClient({
      url: config.server,
      token: config.token,
      space: config.space,
    });

  const result = await client.memory.create({
    content,
    tree: config.treePrefix,
    meta,
    temporal: { start: now.toISOString() },
  });

  return { status: "captured", memoryId: result.id };
}
