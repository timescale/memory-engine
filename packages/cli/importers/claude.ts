/**
 * Claude Code conversation importer.
 *
 * Reads sessions from `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`
 * (and `agent-*.jsonl` sidechain files). One file = one session.
 *
 * Each line is a JSON event. Event types we care about: `user` and `assistant`
 * messages. `permission-mode`, `file-history-snapshot`, and `isMeta:true` are
 * skipped. Message content may be either a plain string (legacy) or an array
 * of content blocks (`text`, `thinking`, `tool_use`, `tool_result`).
 *
 * Each kept source event becomes one `ConversationMessage`, and the shared
 * writer turns each message into its own memory in the engine.
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

const DEFAULT_SOURCE = join(homedir(), ".claude", "projects");

/** Regex matching wrapped local-command payloads we should ignore in search. */
const LOCAL_COMMAND_WRAPPERS = [
  /^<local-command-caveat>[\s\S]*<\/local-command-caveat>$/,
  /^<command-name>[\s\S]*<\/command-args>\s*$/,
  /^<local-command-stdout>[\s\S]*<\/local-command-stdout>$/,
  /^<command-message>[\s\S]*<\/command-message>$/,
];

/**
 * Prefixes that mark a user text block as an SDK / proxy replay wrapper.
 *
 * Seen in the wild:
 *   - Claude Code TS SDK (`entrypoint: "sdk-ts"`) re-serializing prior turns
 *     into a user message as plain text, prepending `Assistant: ` / `Human: `
 *     role labels (or bracket-wrapping turns as `[Assistant: ...]` /
 *     `[Tool Use: ...]` / `[Tool Result for ...]`).
 *   - Proxies like `opencode-claude-max-proxy` stuffing the full system
 *     prompt + conversation history into each user event as one giant text
 *     block, terminating with `\n\nHuman: <real new prompt>`. These always
 *     start with `"You are "` (the Claude/OpenCode system prompt preamble).
 *
 * Text blocks starting with any of these are wrapper noise; the real prompt
 * (if any) lives after the last `\n\nHuman: ` marker in the block.
 */
const SDK_REPLAY_PREFIXES = [
  "Assistant: ",
  "Human: ",
  "[Assistant: ",
  "[Tool Use:",
  "[Tool Result for",
  "You are Claude Code",
  "You are OpenCode",
];

/** Separator used between serialized turns inside SDK replay bundles. */
const SDK_REPLAY_HUMAN_MARKER = "\n\nHuman: ";

export const claudeImporter: Importer = {
  tool: "claude",
  defaultSource: DEFAULT_SOURCE,
  discoverSessions,
};

async function* discoverSessions(
  options: ImporterOptions,
  stats: ImporterStats,
  progress?: ProgressReporter,
): AsyncIterable<ImportedSession> {
  const source = options.source ?? DEFAULT_SOURCE;

  let projectDirs: string[];
  try {
    projectDirs = await listSubdirs(source);
  } catch {
    return;
  }

  for (const projectDir of projectDirs) {
    const files = await listJsonlFiles(projectDir);
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
          isSidechain: session.isSidechain,
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

/** Count messages whose role is `user` and that carry at least one text block. */
function countUserMessages(messages: ConversationMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (m.blocks.some((b) => b.kind === "text")) n++;
  }
  return n;
}

/** List immediate subdirectories of `path`. */
async function listSubdirs(path: string): Promise<string[]> {
  const entries = await fs.readdir(path, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => join(path, e.name))
    .sort();
}

/** List `.jsonl` files directly under `path`. */
async function listJsonlFiles(path: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => join(path, e.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Parse a single Claude session file into a normalized ImportedSession.
 * Returns null for empty files or files that contain no message events.
 */
async function parseSessionFile(file: string): Promise<ImportedSession | null> {
  const content = await fs.readFile(file, "utf-8");
  const lines = content.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  const messages: ConversationMessage[] = [];
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let version: string | undefined;
  let isSidechain: boolean | undefined;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let model: string | undefined;
  /**
   * PromptIds seen on `isMeta:true` events. When a tool call is blocked
   * by a hook, the Claude SDK inserts a synthetic `isMeta` "Continue from
   * where you left off." user message, a `<synthetic>` assistant response,
   * and a replay user message that re-serializes the prior assistant turn
   * + tool_use + tool_result as plain text. All three share a promptId,
   * and the real conversation resumes under a fresh promptId. Tracking the
   * meta promptIds lets us drop the whole wrapper cycle cleanly.
   */
  const metaPromptIds = new Set<string>();

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Skip malformed lines but don't fail the whole session.
      continue;
    }

    // Harvest session-level fields whenever present.
    if (!sessionId && typeof event.sessionId === "string") {
      sessionId = event.sessionId;
    }
    if (!cwd && typeof event.cwd === "string") cwd = event.cwd;
    if (!gitBranch && typeof event.gitBranch === "string") {
      gitBranch = event.gitBranch;
    }
    if (!version && typeof event.version === "string") version = event.version;
    if (typeof event.isSidechain === "boolean" && isSidechain === undefined) {
      isSidechain = event.isSidechain;
    }

    const type = event.type;
    if (type !== "user" && type !== "assistant") continue;

    // Record meta promptIds for replay suppression, then skip the meta event.
    if (event.isMeta === true) {
      if (typeof event.promptId === "string") {
        metaPromptIds.add(event.promptId);
      }
      continue;
    }

    const message =
      (event.message as Record<string, unknown> | undefined) ?? {};

    // Skip synthetic assistant responses the SDK inserts after a blocked hook
    // ("No response requested." with model=<synthetic>).
    if (type === "assistant" && message.model === "<synthetic>") {
      continue;
    }

    // Skip SDK wrapper replay messages: a user event that belongs to a
    // blocked-hook cycle (shares a promptId with an `isMeta` event) just
    // re-serializes prior context as plain text — noise, not a real turn.
    if (
      type === "user" &&
      typeof event.promptId === "string" &&
      metaPromptIds.has(event.promptId)
    ) {
      continue;
    }

    const timestamp =
      typeof event.timestamp === "string" ? event.timestamp : undefined;
    if (timestamp) {
      if (!firstTimestamp) firstTimestamp = timestamp;
      lastTimestamp = timestamp;
    }

    if (type === "assistant" && !model && typeof message.model === "string") {
      model = message.model;
    }

    const messageId = typeof event.uuid === "string" ? event.uuid : undefined;
    if (!messageId) continue;
    if (!timestamp) continue;

    const blocks = extractBlocksForEvent(type, message.content);
    if (blocks.length === 0) continue;

    messages.push({
      messageId,
      timestamp,
      role: type,
      blocks,
    });
  }

  if (!sessionId) return null;
  if (messages.length === 0) return null;

  const stat = await fs.stat(file).catch(() => null);
  const sourceModifiedAt = stat
    ? new Date(stat.mtimeMs).toISOString()
    : (lastTimestamp ?? firstTimestamp ?? new Date(0).toISOString());
  const startedAt = firstTimestamp ?? lastTimestamp ?? sourceModifiedAt;
  const endedAt = lastTimestamp ?? startedAt;

  return {
    tool: "claude",
    sessionId,
    cwd,
    gitBranch,
    toolVersion: version,
    model,
    provider: model ? "anthropic" : undefined,
    sourceFile: file,
    startedAt,
    endedAt,
    sourceModifiedAt,
    messages,
    isSidechain: isSidechain === true ? true : undefined,
  };
}

/**
 * Extract `MessageBlock`s from a Claude event's `message.content`.
 *
 * - User-side text blocks are run through `unwrapSdkReplayBundle` to strip
 *   SDK/proxy wrappers; local-command wrappers are dropped entirely.
 * - Empty/filtered blocks are omitted so an event with only noise content
 *   produces no message at all.
 */
function extractBlocksForEvent(
  type: "user" | "assistant",
  content: unknown,
): MessageBlock[] {
  const raw = normalizeContent(content);
  const out: MessageBlock[] = [];
  for (const block of raw) {
    if (type === "user" && block.kind === "text") {
      const unwrapped = unwrapSdkReplayBundle(block.text);
      if (unwrapped === null) continue;
      if (isLocalCommandWrapper(unwrapped)) continue;
      out.push({ kind: "text", text: unwrapped });
    } else {
      out.push(block);
    }
  }
  return out;
}

/**
 * Normalize Claude `message.content` (string or block array) into a list of
 * `MessageBlock`s.
 */
function normalizeContent(content: unknown): MessageBlock[] {
  if (typeof content === "string") {
    return [{ kind: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];
  const out: MessageBlock[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const entry = block as Record<string, unknown>;
    const type = entry.type;
    if (type === "text" && typeof entry.text === "string") {
      out.push({ kind: "text", text: entry.text });
    } else if (type === "thinking" && typeof entry.thinking === "string") {
      out.push({ kind: "thinking", text: entry.thinking });
    } else if (type === "tool_use") {
      const name = typeof entry.name === "string" ? entry.name : "tool";
      const input =
        entry.input !== undefined ? JSON.stringify(entry.input) : "";
      out.push({
        kind: "tool_use",
        text: input ? `${name}(${input})` : name,
        toolName: name,
      });
    } else if (type === "tool_result") {
      const raw = entry.content;
      let text: string;
      if (typeof raw === "string") {
        text = raw;
      } else if (Array.isArray(raw)) {
        text = raw
          .map((b) => {
            if (typeof b === "string") return b;
            if (typeof b === "object" && b !== null) {
              const bo = b as Record<string, unknown>;
              if (typeof bo.text === "string") return bo.text;
            }
            return "";
          })
          .join("\n");
      } else {
        text = JSON.stringify(raw ?? null);
      }
      out.push({ kind: "tool_result", text });
    }
  }
  return out;
}

/**
 * True if the user text is one of the Claude CLI's synthetic local-command
 * wrappers (noise we don't want to treat as a real prompt).
 */
function isLocalCommandWrapper(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  return LOCAL_COMMAND_WRAPPERS.some((re) => re.test(trimmed));
}

/**
 * Extract the real new user prompt from an SDK replay bundle, or return the
 * text unchanged if it's not a bundle.
 *
 * Returns:
 *   - the original text if it's not a wrapper (no replay prefix)
 *   - the text after the last `\n\nHuman: ` marker if the block bundles
 *     multiple serialized turns
 *   - the text with a leading `Human: ` stripped if that's the only prefix
 *     and there are no internal turn separators
 *   - null when the block is pure replay with no new prompt to extract
 *     (e.g. `[Assistant: ...]` serializations of prior assistant turns)
 *
 * Background: the Claude Code TS SDK sometimes packages prior conversation
 * context into a user message as plain text — either as a single bundled
 * string (`"Assistant: ...\n\nHuman: ...\n\nHuman: <new>"`), or as multiple
 * text blocks where replayed turns are bracket-wrapped as `[Assistant: ...]`.
 * Both patterns need to be stripped so the transcript shows only the real
 * new prompt, not the serialized history preamble.
 */
export function unwrapSdkReplayBundle(text: string): string | null {
  const trimmed = text.trimStart();
  const isReplay = SDK_REPLAY_PREFIXES.some((p) => trimmed.startsWith(p));
  if (!isReplay) return text;

  const lastHumanIdx = text.lastIndexOf(SDK_REPLAY_HUMAN_MARKER);
  if (lastHumanIdx >= 0) {
    return text.slice(lastHumanIdx + SDK_REPLAY_HUMAN_MARKER.length).trim();
  }

  // No internal turn separator. If the block only has a leading `Human: `
  // prefix (i.e. the original first prompt with no replayed history yet),
  // strip it and keep the content. Anything else is pure replay — drop it.
  if (trimmed.startsWith("Human: ")) {
    const stripped = trimmed.slice("Human: ".length).trim();
    return stripped.length > 0 ? stripped : null;
  }
  return null;
}
