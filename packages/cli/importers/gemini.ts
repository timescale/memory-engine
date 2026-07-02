/**
 * Gemini CLI conversation importer.
 *
 * Gemini stores sessions as JSONL under
 * `~/.gemini/tmp/<project_hash>/chats/session-<ts>-<id8>.jsonl` (legacy single-
 * object `.json` files are migrated to `.jsonl` on resume). Layout
 * (P0-verified against gemini-cli `chatRecordingTypes.ts`):
 *
 *   Line 1: metadata `{ sessionId, projectHash, startTime, lastUpdated,
 *            kind: 'main'|'subagent', directories? }`
 *   Lines 2+: `MessageRecord { id, timestamp, type, content, toolCalls?,
 *              thoughts?, tokens?, model? }` where `type` is
 *              'user' | 'gemini' | 'info' | 'error' | 'warning'
 *   Plus `{ "$set": {...} }` metadata updates and `{ "$rewindTo": id }` markers.
 *
 * `content` is a Gemini `PartListUnion` (a string, a Part, or an array of
 * those); a Part may carry `text`, `thought`, `functionCall`, or
 * `functionResponse`. We keep user + gemini turns; info/error/warning are UI
 * noise and skipped. `$rewindTo` is ignored (we import everything — the server's
 * conditional upsert reconciles; over-importing a rewound tail is harmless).
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
  MessageBlock,
} from "./types.ts";

const DEFAULT_SOURCE = join(homedir(), ".gemini", "tmp");

export const geminiImporter: Importer = {
  tool: "gemini",
  defaultSource: DEFAULT_SOURCE,
  discoverSessions,
  // Live-capture path (`me gemini hook`): the hook payload carries the
  // transcript path directly, so parseFile is the primary entry point.
  parseFile: parseSessionFile,
};

async function* discoverSessions(
  options: ImporterOptions,
  stats: ImporterStats,
  progress?: ProgressReporter,
): AsyncIterable<ImportedSession> {
  const root = options.source ?? DEFAULT_SOURCE;
  const files = await findChatFiles(root);
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

function countUserMessages(messages: ConversationMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role === "user" && m.blocks.some((b) => b.kind === "text")) n++;
  }
  return n;
}

/** Collect session transcripts: `.jsonl`/`.json` files inside any `chats/` dir
 * under the tmp root. */
async function findChatFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, inChats: boolean): Promise<void> {
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p, inChats || e.name === "chats");
      else if (
        inChats &&
        e.isFile() &&
        (e.name.endsWith(".jsonl") || e.name.endsWith(".json"))
      ) {
        out.push(p);
      }
    }
  }
  await walk(root, false);
  out.sort();
  return out;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name?: string; args?: unknown };
  functionResponse?: { name?: string; response?: unknown };
}

/** Normalize a Gemini `PartListUnion` to an array of Parts. */
function normalizeParts(content: unknown): GeminiPart[] {
  if (content == null) return [];
  const arr = Array.isArray(content) ? content : [content];
  return arr.map((p) =>
    typeof p === "string" ? { text: p } : (p as GeminiPart),
  );
}

/** Build message blocks from a record's `content` parts + optional toolCalls. */
function blocksFromRecord(raw: Record<string, unknown>): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  for (const part of normalizeParts(raw.content)) {
    if (typeof part.text === "string" && part.text.length > 0) {
      blocks.push({
        kind: part.thought ? "thinking" : "text",
        text: part.text,
      });
    } else if (part.functionCall) {
      const name = part.functionCall.name ?? "tool";
      blocks.push({
        kind: "tool_use",
        toolName: name,
        text: `${name}(${
          part.functionCall.args === undefined
            ? ""
            : JSON.stringify(part.functionCall.args)
        })`,
      });
    } else if (part.functionResponse) {
      const name = part.functionResponse.name ?? "tool";
      blocks.push({
        kind: "tool_result",
        toolName: name,
        text: JSON.stringify(part.functionResponse.response ?? null),
      });
    }
  }
  // Gemini assistant records may also carry a structured `toolCalls` array.
  const toolCalls = raw.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls as Array<Record<string, unknown>>) {
      const name = typeof tc.name === "string" ? tc.name : "tool";
      blocks.push({
        kind: "tool_use",
        toolName: name,
        text: `${name}(${tc.args === undefined ? "" : JSON.stringify(tc.args)})`,
      });
      if (tc.result !== undefined) {
        blocks.push({
          kind: "tool_result",
          toolName: name,
          text:
            typeof tc.result === "string"
              ? tc.result
              : JSON.stringify(tc.result),
        });
      }
    }
  }
  return blocks;
}

const MESSAGE_TYPES = new Set(["user", "gemini"]);

/** Parse a single Gemini session file into a normalized ImportedSession. */
async function parseSessionFile(file: string): Promise<ImportedSession | null> {
  const content = await fs.readFile(file, "utf-8");
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;

  // Gather records: JSONL (one object per line) or a legacy single JSON object.
  let records: Array<Record<string, unknown>>;
  if (
    file.endsWith(".json") &&
    trimmed.startsWith("{") &&
    !trimmed.includes("\n{")
  ) {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const msgs = Array.isArray(obj.messages)
      ? (obj.messages as Array<Record<string, unknown>>)
      : [];
    records = [obj, ...msgs];
  } else {
    records = trimmed
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  if (records.length === 0) return null;

  let sessionId: string | undefined;
  let startTime: string | undefined;
  let lastUpdated: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  const messages: ConversationMessage[] = [];
  let ordinal = 0;

  for (const rec of records) {
    if ("$rewindTo" in rec) continue; // ignore rewinds (idempotent re-import)
    if ("$set" in rec) {
      const set = rec.$set as Record<string, unknown> | undefined;
      if (typeof set?.lastUpdated === "string") lastUpdated = set.lastUpdated;
      continue;
    }
    const type = rec.type;
    if (typeof type !== "string") {
      // Metadata line (no message type).
      if (typeof rec.sessionId === "string") sessionId = rec.sessionId;
      if (typeof rec.startTime === "string") startTime = rec.startTime;
      if (typeof rec.lastUpdated === "string") lastUpdated = rec.lastUpdated;
      const dirs = rec.directories;
      if (Array.isArray(dirs) && typeof dirs[0] === "string") cwd = dirs[0];
      else if (typeof rec.cwd === "string") cwd = rec.cwd;
      continue;
    }
    if (!MESSAGE_TYPES.has(type)) continue; // info / error / warning: UI noise
    if (typeof rec.model === "string" && !model) model = rec.model;

    const blocks = blocksFromRecord(rec);
    if (blocks.length === 0) continue;
    const timestamp =
      typeof rec.timestamp === "string" ? rec.timestamp : startTime;
    messages.push({
      messageId: typeof rec.id === "string" ? rec.id : `${type}:${ordinal}`,
      timestamp: timestamp ?? new Date(0).toISOString(),
      role: type === "user" ? "user" : "assistant",
      blocks,
    });
    ordinal++;
  }

  if (messages.length === 0) return null;

  const stat = await fs.stat(file).catch(() => null);
  const sourceModifiedAt = stat
    ? new Date(stat.mtimeMs).toISOString()
    : (lastUpdated ?? new Date(0).toISOString());
  const startedAt = startTime ?? messages[0]?.timestamp ?? sourceModifiedAt;
  const endedAt =
    lastUpdated ?? messages[messages.length - 1]?.timestamp ?? startedAt;

  return {
    tool: "gemini",
    sessionId: sessionId ?? sessionIdFromFilename(file),
    cwd,
    model,
    provider: "google",
    sourceFile: file,
    startedAt,
    endedAt,
    sourceModifiedAt,
    messages,
  };
}

/** Fallback session id from the filename (`session-<ts>-<id8>.jsonl`). */
function sessionIdFromFilename(file: string): string {
  const base = file.split("/").pop() ?? file;
  return base.replace(/\.(jsonl|json)$/i, "");
}
