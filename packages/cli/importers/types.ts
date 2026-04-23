/**
 * Shared types for agent conversation importers.
 *
 * Each importer (claude, codex, opencode) produces a stream of `ImportedSession`
 * objects. Each session carries an ordered list of `ConversationMessage`s,
 * and the shared writer turns each message into one memory in the engine
 * (keyed by a deterministic UUIDv7 derived from tool + session id + message id).
 */

/** Supported source tool names. */
export type SourceTool = "claude" | "codex" | "opencode";

/**
 * A single content block inside a source-native message.
 *
 * Claude and OpenCode can pack multiple blocks into one message — for
 * example, an assistant message with a `thinking` block, a `text` block,
 * and a `tool_use` block. We preserve blocks as an ordered list so the
 * writer can decide which ones to render based on the requested content
 * mode (`default` keeps only `text`; `--full-transcript` keeps everything).
 */
export interface MessageBlock {
  /** Content kind for this block. */
  kind: "text" | "thinking" | "tool_use" | "tool_result" | "system";
  /** Rendered text for this block. */
  text: string;
  /** Tool name for `tool_use` / `tool_result` blocks. */
  toolName?: string;
}

/**
 * One source-native message within a conversation.
 *
 * Becomes exactly one memory in the engine. The memory's id is a
 * deterministic UUIDv7 derived from `(tool, sessionId, messageId,
 * timestampMs)` and its temporal is a point-in-time at `timestamp`.
 *
 * Codex records response items without a native id for some types
 * (reasoning, function_call, function_call_output). For those the
 * importer synthesizes a stable id from `(sessionId, type, ordinal)`
 * so re-imports remain idempotent.
 */
export interface ConversationMessage {
  /** Stable source-native id (synthesized if the source doesn't supply one). */
  messageId: string;
  /** ISO 8601 timestamp of this message. */
  timestamp: string;
  /**
   * Source-native role. `user` / `assistant` / `system` wrap text content;
   * `reasoning` / `tool_call` / `tool_result` describe standalone items
   * (Codex response items) or single-block messages that don't fit the
   * user/assistant/system buckets.
   */
  role:
    | "user"
    | "assistant"
    | "reasoning"
    | "tool_call"
    | "tool_result"
    | "system";
  /** Ordered blocks composing this message. */
  blocks: MessageBlock[];
  /** Tool name for `tool_call` / `tool_result` messages at the message level. */
  toolName?: string;
}

/**
 * A normalized view of a single agent conversation session.
 *
 * Filled in by the per-tool importer and consumed by the shared writer,
 * which fans `messages[]` out into individual memories.
 */
export interface ImportedSession {
  /** Source tool that produced this session. */
  tool: SourceTool;
  /** Tool-native session identifier (UUID, slug, etc.). */
  sessionId: string;
  /** Optional human-readable session title. */
  title?: string;
  /** Absolute path to the working directory the session ran in. */
  cwd?: string;
  /** Git branch at session start, if known. */
  gitBranch?: string;
  /** Git commit hash at session start, if known. */
  gitCommit?: string;
  /** Git remote URL, if known. */
  gitRepo?: string;
  /** Tool version string (e.g. claude CLI version). */
  toolVersion?: string;
  /** Model identifier (e.g. "claude-opus-4-5"). */
  model?: string;
  /** Model provider (e.g. "anthropic", "openai", "google"). */
  provider?: string;
  /** Optional agent mode (e.g. "plan" for opencode). */
  agentMode?: string;
  /** Absolute path to the source file on disk, for traceability. */
  sourceFile: string;
  /** Session start timestamp (ISO 8601). */
  startedAt: string;
  /** Session end (last message) timestamp (ISO 8601). */
  endedAt: string;
  /** Timestamp the source file was last modified on disk. */
  sourceModifiedAt: string;
  /** All messages in source order. */
  messages: ConversationMessage[];
  /** True if the session is marked as a subagent/sidechain (Claude). */
  isSidechain?: boolean;
}

/** Options that affect what each importer emits. */
export interface ImporterOptions {
  /** Override the default source directory for this tool. */
  source?: string;
  /** Only include sessions whose cwd equals (or is under) this path. */
  projectFilter?: string;
  /** Only include sessions started at or after this ISO timestamp. */
  since?: string;
  /** Only include sessions started at or before this ISO timestamp. */
  until?: string;
  /** Include full transcript details (reasoning, tool calls, tool results). */
  fullTranscript: boolean;
  /** Include subagent/sidechain sessions (Claude-only). */
  includeSidechains: boolean;
  /** Include sessions whose cwd is a system temp directory. */
  includeTempCwd: boolean;
  /** Include trivially-short sessions. */
  includeTrivial: boolean;
}

/** Stats reported back from an importer discovery pass. */
export interface ImporterStats {
  /** Total source files considered. */
  totalFiles: number;
  /** Sessions that were yielded to the caller. */
  yielded: number;
  /** Per-reason skip counts. */
  skipped: Record<string, number>;
  /** Per-file parse errors keyed by source path. */
  errors: Array<{ source: string; error: string }>;
}

/**
 * Standard reasons an importer may skip a session. Importers add to
 * `stats.skipped[reason]` as they go.
 */
export type SkipReason =
  | "sidechain"
  | "temp_cwd"
  | "trivial"
  | "project_filter"
  | "since_filter"
  | "until_filter"
  | "empty"
  | "parse_error";
