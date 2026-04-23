/**
 * OpenCode conversation importer.
 *
 * OpenCode's storage is spread across four directories:
 *
 *   ~/.local/share/opencode/storage/
 *     project/<project-id>.json            metadata: {id, worktree, vcs, time}
 *     session/<project-id>/ses_<id>.json   {id, slug, projectID, directory,
 *                                           title, time: {created, updated}}
 *     message/ses_<id>/msg_<id>.json       {id, role, time, agent, model,
 *                                           providerID, cost, tokens}
 *     part/msg_<id>/prt_<id>.json          {type: "text"|"reasoning"|"tool"|
 *                                           "step-start"|"step-finish",
 *                                           text|state, time}
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

const DEFAULT_SOURCE = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "storage",
);

export const opencodeImporter: Importer = {
  tool: "opencode",
  defaultSource: DEFAULT_SOURCE,
  discoverSessions,
};

async function* discoverSessions(
  options: ImporterOptions,
  stats: ImporterStats,
  progress?: ProgressReporter,
): AsyncIterable<ImportedSession> {
  const storage = options.source ?? DEFAULT_SOURCE;
  const sessionRoot = join(storage, "session");

  let projectDirs: string[];
  try {
    projectDirs = await listSubdirs(sessionRoot);
  } catch {
    return;
  }

  for (const projectDir of projectDirs) {
    const sessionFiles = await listJsonFiles(projectDir);
    for (const sessionFile of sessionFiles) {
      stats.totalFiles++;
      progress?.scan(sessionFile);
      let session: ImportedSession | null;
      try {
        session = await parseSession(sessionFile, storage);
      } catch (error) {
        stats.errors.push({
          source: sessionFile,
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

/** List immediate subdirectories of `path`. */
async function listSubdirs(path: string): Promise<string[]> {
  const entries = await fs.readdir(path, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => join(path, e.name))
    .sort();
}

/** List JSON files directly under `path`. */
async function listJsonFiles(path: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => join(path, e.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Read one OpenCode session file and assemble the full ImportedSession
 * by walking its message + part directories.
 */
async function parseSession(
  sessionFile: string,
  storageRoot: string,
): Promise<ImportedSession | null> {
  const sessionRaw = await readJson(sessionFile);
  if (!sessionRaw) return null;
  const sid = typeof sessionRaw.id === "string" ? sessionRaw.id : undefined;
  if (!sid) return null;

  const title =
    typeof sessionRaw.title === "string" ? sessionRaw.title : undefined;
  const directory =
    typeof sessionRaw.directory === "string" ? sessionRaw.directory : undefined;
  const version =
    typeof sessionRaw.version === "string" ? sessionRaw.version : undefined;
  const sessionTime = sessionRaw.time as
    | { created?: number; updated?: number }
    | undefined;
  const createdMs = sessionTime?.created;
  const updatedMs = sessionTime?.updated;

  // Walk messages for this session, sorted by creation time.
  const messageDir = join(storageRoot, "message", sid);
  const messageFiles = await listJsonFiles(messageDir);

  interface MessageMeta {
    id: string;
    role: string;
    createdMs: number;
    completedMs?: number;
    model?: string;
    providerID?: string;
    agent?: string;
    cost?: number;
    tokens?: TokenCounts;
  }

  const messages: MessageMeta[] = [];
  let model: string | undefined;
  let provider: string | undefined;
  let agentMode: string | undefined;
  let totalCost = 0;
  const aggregateTokens: TokenCounts = {};

  for (const mf of messageFiles) {
    const raw = await readJson(mf);
    if (!raw) continue;
    const id = typeof raw.id === "string" ? raw.id : undefined;
    const role = typeof raw.role === "string" ? raw.role : undefined;
    const time = raw.time as
      | { created?: number; completed?: number }
      | undefined;
    if (!id || !role || !time?.created) continue;
    const msgModel =
      typeof raw.modelID === "string"
        ? raw.modelID
        : typeof (raw.model as Record<string, unknown>)?.modelID === "string"
          ? ((raw.model as Record<string, unknown>).modelID as string)
          : undefined;
    const msgProvider =
      typeof raw.providerID === "string"
        ? raw.providerID
        : typeof (raw.model as Record<string, unknown>)?.providerID === "string"
          ? ((raw.model as Record<string, unknown>).providerID as string)
          : undefined;
    const agent = typeof raw.agent === "string" ? raw.agent : undefined;
    if (!model && msgModel) model = msgModel;
    if (!provider && msgProvider) provider = msgProvider;
    if (!agentMode && agent) agentMode = agent;

    const cost = typeof raw.cost === "number" ? raw.cost : undefined;
    if (cost !== undefined) totalCost += cost;
    const tokens = raw.tokens as Record<string, unknown> | undefined;
    mergeTokens(aggregateTokens, tokens);

    messages.push({
      id,
      role,
      createdMs: time.created,
      completedMs: time.completed,
      model: msgModel,
      providerID: msgProvider,
      agent,
      cost,
      tokens: extractTokens(tokens),
    });
  }
  messages.sort((a, b) => a.createdMs - b.createdMs);

  // Resolve worktree/vcs from project record when session.directory is absent.
  let cwd = directory;
  const projectID =
    typeof sessionRaw.projectID === "string" ? sessionRaw.projectID : undefined;
  if (!cwd && projectID) {
    const proj = await readJson(
      join(storageRoot, "project", `${projectID}.json`),
    );
    if (proj && typeof proj.worktree === "string") cwd = proj.worktree;
  }

  // Now walk parts per message, stitching text/reasoning/tool into turns.
  const turns: ConversationTurn[] = [];
  const counts: MessageCounts = { user: 0, assistant: 0, tool_calls: 0 };
  let lastMessageId = sid;

  for (const m of messages) {
    lastMessageId = m.id;
    const partDir = join(storageRoot, "part", m.id);
    const partFiles = await listJsonFiles(partDir);
    const parts: Array<Record<string, unknown>> = [];
    for (const pf of partFiles) {
      const part = await readJson(pf);
      if (part) parts.push(part);
    }
    parts.sort((a, b) => {
      const at =
        ((a.time as Record<string, unknown> | undefined)?.start as number) ?? 0;
      const bt =
        ((b.time as Record<string, unknown> | undefined)?.start as number) ?? 0;
      return at - bt;
    });

    const messageTs = new Date(m.createdMs).toISOString();
    let userPartCount = 0;
    let assistantPartCount = 0;

    for (const part of parts) {
      const type = part.type;
      const partTime = part.time as
        | { start?: number; end?: number }
        | undefined;
      const partTs = partTime?.start
        ? new Date(partTime.start).toISOString()
        : messageTs;

      if (type === "text" && typeof part.text === "string") {
        const role = m.role === "user" ? "user" : "assistant";
        turns.push({ role, text: part.text, timestamp: partTs });
        if (role === "user") userPartCount++;
        else assistantPartCount++;
      } else if (type === "reasoning" && typeof part.text === "string") {
        turns.push({
          role: "reasoning",
          text: part.text,
          timestamp: partTs,
        });
      } else if (type === "tool") {
        const toolName = typeof part.tool === "string" ? part.tool : "tool";
        const state = part.state as Record<string, unknown> | undefined;
        const input = state?.input;
        const output = state?.output;
        const callLabel = `${toolName}(${
          input === undefined ? "" : JSON.stringify(input)
        })`;
        turns.push({
          role: "tool_call",
          text: callLabel,
          toolName,
          timestamp: partTs,
        });
        counts.tool_calls++;
        if (output !== undefined) {
          const text =
            typeof output === "string" ? output : JSON.stringify(output);
          turns.push({
            role: "tool_result",
            text,
            toolName,
            timestamp: partTs,
          });
        }
      }
      // step-start / step-finish are lifecycle markers; skip.
    }

    // Count one user/assistant message per source message that actually
    // yielded text content, regardless of how many parts it had.
    if (m.role === "user" && userPartCount > 0) counts.user++;
    if (m.role === "assistant" && assistantPartCount > 0) counts.assistant++;
  }

  const stat = await fs.stat(sessionFile).catch(() => null);
  const sourceModifiedAt = stat
    ? new Date(stat.mtimeMs).toISOString()
    : updatedMs
      ? new Date(updatedMs).toISOString()
      : new Date(0).toISOString();
  const startedAt =
    createdMs !== undefined
      ? new Date(createdMs).toISOString()
      : (turns[0]?.timestamp ?? sourceModifiedAt);
  const endedAt =
    updatedMs !== undefined
      ? new Date(updatedMs).toISOString()
      : (turns[turns.length - 1]?.timestamp ?? startedAt);

  if (turns.length === 0 && counts.user === 0 && counts.assistant === 0) {
    return null;
  }

  return {
    tool: "opencode",
    sessionId: sid,
    title,
    cwd,
    toolVersion: version,
    model,
    provider,
    agentMode,
    sourceFile: sessionFile,
    startedAt,
    endedAt,
    sourceModifiedAt,
    lastMessageId,
    messageCounts: counts,
    tokens:
      Object.keys(aggregateTokens).length > 0 ? aggregateTokens : undefined,
    costUsd: totalCost > 0 ? totalCost : undefined,
    turns,
  };
}

/** Safe JSON read; returns null on any error. */
async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await fs.readFile(path, "utf-8");
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Fold tokens from one message's `tokens` payload into an accumulator.
 * OpenCode structure: `{input, output, reasoning, cache: {read, write}}`
 */
function mergeTokens(
  agg: TokenCounts,
  src: Record<string, unknown> | undefined,
): void {
  if (!src) return;
  if (typeof src.input === "number") agg.input = (agg.input ?? 0) + src.input;
  if (typeof src.output === "number")
    agg.output = (agg.output ?? 0) + src.output;
  if (typeof src.reasoning === "number")
    agg.reasoning = (agg.reasoning ?? 0) + src.reasoning;
  const cache = src.cache as Record<string, unknown> | undefined;
  if (cache) {
    if (typeof cache.read === "number")
      agg.cache_read = (agg.cache_read ?? 0) + cache.read;
    if (typeof cache.write === "number")
      agg.cache_write = (agg.cache_write ?? 0) + cache.write;
  }
}

/** Snapshot of tokens for a single message (not aggregated). */
function extractTokens(
  src: Record<string, unknown> | undefined,
): TokenCounts | undefined {
  if (!src) return undefined;
  const out: TokenCounts = {};
  if (typeof src.input === "number") out.input = src.input;
  if (typeof src.output === "number") out.output = src.output;
  if (typeof src.reasoning === "number") out.reasoning = src.reasoning;
  const cache = src.cache as Record<string, unknown> | undefined;
  if (cache) {
    if (typeof cache.read === "number") out.cache_read = cache.read;
    if (typeof cache.write === "number") out.cache_write = cache.write;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
