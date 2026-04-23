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
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { filterBySessionShape, recordSkip } from "./filters.ts";
import type { Importer } from "./index.ts";
import type { ProgressReporter } from "./progress.ts";
import type {
  ConversationTurn,
  ImportedSession,
  ImporterOptions,
  ImporterStats,
  MessageCounts,
  TokenCounts,
} from "./types.ts";

const DEFAULT_SOURCE = join(homedir(), ".codex", "sessions");
const ARCHIVED_SOURCE = join(homedir(), ".codex", "archived_sessions");

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
      const skip = filterBySessionShape(session, options);
      if (skip) {
        recordSkip(stats, skip);
        continue;
      }
      stats.yielded++;
      yield session;
    }
  }
}

/**
 * Walk a directory tree and collect `.jsonl` files.
 */
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
 * Parse a single Codex session file.
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

  const turns: ConversationTurn[] = [];
  const counts: MessageCounts = { user: 0, assistant: 0, tool_calls: 0 };
  const tokens: TokenCounts = {};
  let lastTimestamp: string | undefined;
  let lastMessageId: string | undefined;
  let model: string | undefined;

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
    // Only process response_item for turns (event_msg is a UI mirror).
    let inner: Record<string, unknown> | undefined;
    if (type === "response_item" && payload) {
      inner = payload;
    } else if (type === "event_msg" && payload) {
      // Harvest token counts, then skip.
      if (payload.type === "token_count") {
        harvestTokenCount(payload, tokens);
      }
      continue;
    } else if (typeof type === "string") {
      // Legacy format: line *is* the payload.
      inner = event;
    } else {
      continue;
    }

    processInner(
      inner,
      timestamp,
      turns,
      counts,
      (id) => {
        lastMessageId = id;
      },
      (m) => {
        if (!model) model = m;
      },
    );
  }

  if (!sessionId) return null;
  if (turns.length === 0) return null;

  const finalStartedAt = startedAt ?? turns[0]?.timestamp ?? sourceModifiedAt;
  const endedAt = lastTimestamp ?? finalStartedAt;

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
    lastMessageId: lastMessageId ?? sessionId,
    messageCounts: counts,
    tokens: Object.keys(tokens).length > 0 ? tokens : undefined,
    turns,
  };
}

/**
 * Extract `(sessionId, startedAt)` from a Codex rollout filename.
 */
function parseFilename(file: string): {
  sessionId?: string;
  startedAt?: string;
} {
  const basename = file.split("/").pop() ?? "";
  const match = basename.match(FILENAME_RE);
  if (!match) return {};
  const [, tsPart, id] = match;
  // Filename uses `-` in the time parts; rebuild ISO-like form.
  // e.g. "2026-03-03T10-32-28" → "2026-03-03T10:32:28Z"
  const iso = tsPart
    ? `${tsPart.slice(0, 10)}T${tsPart.slice(11).replaceAll("-", ":")}Z`
    : undefined;
  return { sessionId: id, startedAt: iso };
}

/**
 * Process a single `response_item.payload` (or legacy top-level item).
 */
function processInner(
  inner: Record<string, unknown>,
  timestamp: string | undefined,
  turns: ConversationTurn[],
  counts: MessageCounts,
  setLastId: (id: string) => void,
  noteModel: (m: string) => void,
): void {
  const innerType = inner.type;
  if (typeof inner.id === "string") setLastId(inner.id);

  if (innerType === "message") {
    const role = inner.role;
    const content = inner.content;
    const text = extractMessageText(content);
    if (!text) return;
    if (role === "user") {
      turns.push({ role: "user", text, timestamp });
      counts.user++;
    } else if (role === "assistant") {
      turns.push({ role: "assistant", text, timestamp });
      counts.assistant++;
    } else if (role === "developer" || role === "system") {
      turns.push({ role: "system", text, timestamp });
    }
    return;
  }

  if (innerType === "reasoning") {
    const summary = inner.summary;
    const text =
      extractMessageText(summary) || extractMessageText(inner.content);
    if (text) turns.push({ role: "reasoning", text, timestamp });
    return;
  }

  if (innerType === "function_call") {
    const name = typeof inner.name === "string" ? inner.name : "function_call";
    const args = typeof inner.arguments === "string" ? inner.arguments : "";
    turns.push({
      role: "tool_call",
      text: args ? `${name}(${args})` : name,
      toolName: name,
      timestamp,
    });
    counts.tool_calls++;
    return;
  }

  if (innerType === "function_call_output") {
    const output =
      typeof inner.output === "string"
        ? inner.output
        : JSON.stringify(inner.output ?? null);
    turns.push({ role: "tool_result", text: output, timestamp });
    return;
  }

  // Heuristic model harvest — codex stores model on some message payloads.
  if (typeof inner.model === "string") noteModel(inner.model);
}

/**
 * Flatten Codex's `content` / `summary` arrays into a single text string.
 */
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

/**
 * Pull token counters out of a token_count event_msg payload.
 */
function harvestTokenCount(
  payload: Record<string, unknown>,
  tokens: TokenCounts,
): void {
  const info = payload.info as Record<string, unknown> | undefined;
  const src = info ?? payload;
  if (typeof src.input_tokens === "number")
    tokens.input = Math.max(tokens.input ?? 0, src.input_tokens);
  if (typeof src.output_tokens === "number")
    tokens.output = Math.max(tokens.output ?? 0, src.output_tokens);
  if (typeof src.reasoning_tokens === "number")
    tokens.reasoning = Math.max(tokens.reasoning ?? 0, src.reasoning_tokens);
  if (typeof src.cached_input_tokens === "number")
    tokens.cache_read = Math.max(
      tokens.cache_read ?? 0,
      src.cached_input_tokens,
    );
}
