/**
 * Codex CLI conversation importer.
 *
 * Reads session rollouts from `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
 * and `~/.codex/archived_sessions/*.jsonl`.
 *
 * Two on-disk formats exist in the wild:
 *
 * Recent (2026+):
 *   Line 1: `{timestamp, type: "session_meta", payload: {id, timestamp, cwd,
 *            cli_version, model_provider, base_instructions, git}}`
 *   Lines 2+: `{timestamp, type: "response_item"|"event_msg", payload: {...}}`
 *   The authoritative content lives in `response_item.payload`. `event_msg`
 *   entries duplicate those for UI display and are ignored here to avoid
 *   double-counting.
 *
 * Legacy (pre-2026):
 *   Each line is a bare response-item-like object (no session_meta,
 *   no `type: "response_item"` wrapper). We fall back to filename parsing
 *   for the session id/timestamp.
 *
 * Each kept response item becomes one `ConversationMessage` whose id is
 * either the native payload `id`, the `call_id` (for tool calls), or a
 * synthesized `{type}:{ordinal}` fallback — stable across re-imports as
 * long as the source rollout file doesn't change.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { filterBySessionShape, recordSkip } from "./filters.ts";
import type { Importer } from "./index.ts";
import type { ProgressReporter } from "./progress.ts";
import type {
  ConversationMessage,
  ImportedSession,
  ImporterOptions,
  ImporterStats,
} from "./types.ts";

const DEFAULT_SOURCE = join(homedir(), ".codex", "sessions");
const ARCHIVED_SOURCE = join(homedir(), ".codex", "archived_sessions");
const ENVIRONMENT_CONTEXT_RE =
  /^<environment_context>\s*[\s\S]*<\/environment_context>$/;
const TURN_ABORTED_RE = /^<turn_aborted>\s*[\s\S]*<\/turn_aborted>$/;
const USER_INSTRUCTIONS_RE =
  /^<user_instructions>\s*[\s\S]*<\/user_instructions>$/;

/** Parse session id + started timestamp out of a rollout filename. */
const FILENAME_RE =
  /rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-f-]+)\.jsonl$/i;

export const codexImporter: Importer = {
  tool: "codex",
  defaultSource: DEFAULT_SOURCE,
  discoverSessions,
};

async function* discoverSessions(
  options: ImporterOptions,
  stats: ImporterStats,
  progress?: ProgressReporter,
): AsyncIterable<ImportedSession> {
  const roots = options.source
    ? [options.source]
    : [DEFAULT_SOURCE, ARCHIVED_SOURCE];

  for (const root of roots) {
    const files = await findJsonlFilesRecursively(root);
    for (const file of files) {
      stats.totalFiles++;
      progress?.scan(file);
      let session: ImportedSession | null;
      try {
        session = await parseSessionFile(file);
      } catch (error) {
        stats.errors.push({
          source: file,
          error: error instanceof Error ? error.message : String(error),
        });
        recordSkip(stats, "parse_error");
        continue;
      }
      if (!session) {
        recordSkip(stats, "empty");
        continue;
      }
      const skip = filterBySessionShape(
        {
          startedAt: session.startedAt,
          userMessageCount: countUserMessages(session.messages),
          cwd: session.cwd,
        },
        options,
      );
      if (skip) {
        recordSkip(stats, skip);
        continue;
      }
      stats.yielded++;
      yield session;
    }
  }
}

/** Count user-role messages that carry at least one text block. */
function countUserMessages(messages: ConversationMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (m.blocks.some((b) => b.kind === "text")) n++;
  }
  return n;
}

/** Walk a directory tree and collect `.jsonl` files. */
async function findJsonlFilesRecursively(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  }
  await walk(root);
  out.sort();
  return out;
}

/**
 * Parse a single Codex session file into a normalized ImportedSession.
 */
async function parseSessionFile(file: string): Promise<ImportedSession | null> {
  const content = await fs.readFile(file, "utf-8");
  const lines = content.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  // Defaults from filename when session_meta is missing.
  const stat = await fs.stat(file).catch(() => null);
  const sourceModifiedAt = stat
    ? new Date(stat.mtimeMs).toISOString()
    : new Date(0).toISOString();
  const filenameFallback = parseFilename(file);

  let sessionId: string | undefined = filenameFallback.sessionId;
  let startedAt: string | undefined = filenameFallback.startedAt;
  let cwd: string | undefined;
  let cliVersion: string | undefined;
  let modelProvider: string | undefined;
  let gitBranch: string | undefined;
  let gitCommit: string | undefined;
  let gitRepo: string | undefined;

  const messages: ConversationMessage[] = [];
  let lastTimestamp: string | undefined;
  let model: string | undefined;
  /** Per-session counters of items lacking a native id, used for stable synth ids. */
  const synthCounters = new Map<string, number>();

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = event.type;
    const payload = event.payload as Record<string, unknown> | undefined;
    const timestamp =
      typeof event.timestamp === "string" ? event.timestamp : undefined;
    if (timestamp) lastTimestamp = timestamp;

    // session_meta header (recent format).
    if (type === "session_meta" && payload) {
      const metaId = typeof payload.id === "string" ? payload.id : undefined;
      if (metaId) sessionId = metaId;
      if (typeof payload.timestamp === "string") startedAt = payload.timestamp;
      if (typeof payload.cwd === "string") cwd = payload.cwd;
      if (typeof payload.cli_version === "string")
        cliVersion = payload.cli_version;
      if (typeof payload.model_provider === "string")
        modelProvider = payload.model_provider;
      const git = payload.git as Record<string, unknown> | undefined;
      if (git) {
        if (typeof git.branch === "string") gitBranch = git.branch;
        if (typeof git.commit_hash === "string") gitCommit = git.commit_hash;
        if (typeof git.repository_url === "string")
          gitRepo = git.repository_url;
      }
      continue;
    }

    // Recent format wraps payloads in response_item/event_msg.
    // Only process response_item for messages; event_msg is a UI mirror.
    let inner: Record<string, unknown> | undefined;
    if (type === "response_item" && payload) {
      inner = payload;
    } else if (type === "event_msg") {
      continue;
    } else if (typeof type === "string") {
      // Legacy format: the line itself is the response-item-shaped payload.
      inner = event;
    } else {
      continue;
    }

    const built = buildMessageFromInner(
      inner,
      timestamp,
      sessionId,
      synthCounters,
    );
    if (built.model && !model) model = built.model;
    if (built.message) messages.push(built.message);
  }

  if (!sessionId) return null;
  if (messages.length === 0) return null;

  const finalStartedAt =
    startedAt ?? messages[0]?.timestamp ?? sourceModifiedAt;
  const endedAt =
    lastTimestamp ?? messages[messages.length - 1]?.timestamp ?? finalStartedAt;

  return {
    tool: "codex",
    sessionId,
    cwd,
    gitBranch,
    gitCommit,
    gitRepo,
    toolVersion: cliVersion,
    model,
    provider: modelProvider,
    sourceFile: file,
    startedAt: finalStartedAt,
    endedAt,
    sourceModifiedAt,
    messages,
  };
}

/** Extract `(sessionId, startedAt)` from a Codex rollout filename. */
function parseFilename(file: string): {
  sessionId?: string;
  startedAt?: string;
} {
  const basename = file.split("/").pop() ?? "";
  const match = basename.match(FILENAME_RE);
  if (!match) return {};
  const [, tsPart, id] = match;
  // Filename uses `-` in the time parts; rebuild ISO-like form.
  const iso = tsPart
    ? `${tsPart.slice(0, 10)}T${tsPart.slice(11).replaceAll("-", ":")}Z`
    : undefined;
  return { sessionId: id, startedAt: iso };
}

/**
 * Build a single `ConversationMessage` from a Codex response-item payload.
 *
 * Returns an object that may carry:
 *   - `message`: the built message, absent when the payload doesn't map
 *     to a surfaceable message (unknown type, empty content, ignored role)
 *   - `model`: a harvested model hint from the payload, if present
 */
function buildMessageFromInner(
  inner: Record<string, unknown>,
  timestamp: string | undefined,
  sessionId: string | undefined,
  synthCounters: Map<string, number>,
): { message?: ConversationMessage; model?: string } {
  const innerType = inner.type;
  const nativeId = typeof inner.id === "string" ? inner.id : undefined;
  const callId = typeof inner.call_id === "string" ? inner.call_id : undefined;
  const modelHint = typeof inner.model === "string" ? inner.model : undefined;
  const ts = timestamp ?? "";

  const synth = (category: string): string => {
    const n = (synthCounters.get(category) ?? 0) + 1;
    synthCounters.set(category, n);
    return `syn:${category}:${sessionId ?? "unknown"}:${n}`;
  };

  if (innerType === "message") {
    const role = inner.role;
    const text = extractMessageText(inner.content);
    if (!text) return { model: modelHint };
    if (role !== "user" && role !== "assistant" && role !== "system") {
      return { model: modelHint };
    }
    const messageId = nativeId ?? synth(`message:${role}`);
    if (role === "user" && isCodexMetaMessage(text)) {
      return { model: modelHint };
    }
    return {
      message: {
        messageId,
        timestamp: ts,
        role,
        blocks: [{ kind: role === "system" ? "system" : "text", text }],
      },
      model: modelHint,
    };
  }

  if (innerType === "reasoning") {
    const text =
      extractMessageText(inner.summary) || extractMessageText(inner.content);
    if (!text) return { model: modelHint };
    const messageId = nativeId ?? synth("reasoning");
    return {
      message: {
        messageId,
        timestamp: ts,
        role: "reasoning",
        blocks: [{ kind: "thinking", text }],
      },
      model: modelHint,
    };
  }

  if (innerType === "function_call") {
    const name = typeof inner.name === "string" ? inner.name : "function_call";
    const args = typeof inner.arguments === "string" ? inner.arguments : "";
    const label = args ? `${name}(${args})` : name;
    const messageId = nativeId ?? callId ?? synth(`call:${name}`);
    return {
      message: {
        messageId,
        timestamp: ts,
        role: "tool_call",
        toolName: name,
        blocks: [{ kind: "tool_use", text: label, toolName: name }],
      },
      model: modelHint,
    };
  }

  if (innerType === "function_call_output") {
    const output =
      typeof inner.output === "string"
        ? inner.output
        : JSON.stringify(inner.output ?? null);
    const messageId = nativeId ?? callId ?? synth("call_output");
    return {
      message: {
        messageId,
        timestamp: ts,
        role: "tool_result",
        blocks: [{ kind: "tool_result", text: output }],
      },
      model: modelHint,
    };
  }

  // Unknown item type — still harvest the model hint if present.
  return { model: modelHint };
}

/** Flatten Codex's `content` / `summary` arrays into a single text string. */
function extractMessageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const block of value) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

function isCodexMetaMessage(text: string): boolean {
  const trimmed = text.trim();
  return (
    ENVIRONMENT_CONTEXT_RE.test(trimmed) ||
    TURN_ABORTED_RE.test(trimmed) ||
    USER_INSTRUCTIONS_RE.test(trimmed) ||
    isCodexInstructionsWrapperMessage(trimmed)
  );
}

function isCodexInstructionsWrapperMessage(text: string): boolean {
  return (
    text.startsWith("# ") &&
    text.includes(" instructions for /") &&
    text.includes("\n\n<INSTRUCTIONS>")
  );
}
