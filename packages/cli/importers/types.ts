/**
 * Shared types for agent conversation importers.
 *
 * Each importer (claude, codex, opencode) produces a stream of `ImportedSession`
 * objects that the shared orchestrator turns into memories via the engine RPC.
 */

/**
 * Supported source tool names.
 */
export type SourceTool = "claude" | "codex" | "opencode";

/**
 * One turn in a conversation (user or assistant).
 *
 * Tool calls, tool results, thinking/reasoning blocks, and system prompts
 * are filtered out at parse time unless `--full-transcript` is set, in which
 * case those are included as additional turn kinds.
 */
export interface ConversationTurn {
  /** ISO 8601 timestamp, or undefined if the source doesn't record it. */
  timestamp?: string;
  /** Role: user / assistant / reasoning / tool_call / tool_result / system. */
  role:
    | "user"
    | "assistant"
    | "reasoning"
    | "tool_call"
    | "tool_result"
    | "system";
  /** The text content of this turn. */
  text: string;
  /** Optional tool name for tool_call/tool_result turns. */
  toolName?: string;
}

/**
 * Counts of message types observed in a session.
 */
export interface MessageCounts {
  user: number;
  assistant: number;
  tool_calls: number;
}

/**
 * Token usage aggregates for a session, if the source records them.
 */
export interface TokenCounts {
  input?: number;
  output?: number;
  reasoning?: number;
  cache_read?: number;
  cache_write?: number;
}

/**
 * A normalized view of a single agent conversation session.
 *
 * Built by the per-tool importer and consumed by the shared writer.
 */
export interface ImportedSession {
  /** Source tool that produced this session. */
  tool: SourceTool;
  /** Tool-native session identifier (UUID, slug, etc.). */
  sessionId: string;
  /** Optional human-readable title; importer may synthesize from first prompt. */
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
  /** Last message timestamp (ISO 8601). */
  endedAt: string;
  /** Timestamp the source file was last modified on disk. */
  sourceModifiedAt: string;
  /** ID of the last message seen in the session (for change detection). */
  lastMessageId: string;
  /** Counts of observed message types. */
  messageCounts: MessageCounts;
  /** Aggregate token usage, if known. */
  tokens?: TokenCounts;
  /** Aggregate USD cost, if known. */
  costUsd?: number;
  /** Ordered list of conversation turns. */
  turns: ConversationTurn[];
  /** True if the session is marked as a subagent/sidechain (Claude). */
  isSidechain?: boolean;
}

/**
 * Options that affect what each importer emits.
 */
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
  /** Include trivially-short sessions (<5 total messages). */
  includeTrivial: boolean;
}

/**
 * Stats reported back from an importer discovery pass.
 */
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
