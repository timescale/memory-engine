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
 *                                           providerID}
 *     part/msg_<id>/prt_<id>.json          {type: "text"|"reasoning"|"tool"|
 *                                           "step-start"|"step-finish",
 *                                           text|state, time}
 *
 * Each `msg_<id>` becomes one `ConversationMessage`, and its parts become
 * the message's ordered blocks. A `tool` part expands into two blocks
 * (one `tool_use` for the call, one `tool_result` for the output) inside
 * the same message.
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

  interface MessageMeta {
    id: string;
    role: string;
    createdMs: number;
    model?: string;
    providerID?: string;
    agent?: string;
  }

  const messageDir = join(storageRoot, "message", sid);
  const messageFiles = await listJsonFiles(messageDir);

  const messageMetas: MessageMeta[] = [];
  let model: string | undefined;
  let provider: string | undefined;
  let agentMode: string | undefined;

  for (const mf of messageFiles) {
    const raw = await readJson(mf);
    if (!raw) continue;
    const id = typeof raw.id === "string" ? raw.id : undefined;
    const role = typeof raw.role === "string" ? raw.role : undefined;
    const time = raw.time as { created?: number } | undefined;
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

    messageMetas.push({
      id,
      role,
      createdMs: time.created,
      model: msgModel,
      providerID: msgProvider,
      agent,
    });
  }
  messageMetas.sort((a, b) => a.createdMs - b.createdMs);

  // Resolve worktree from the project record when session.directory is absent.
  let cwd = directory;
  const projectID =
    typeof sessionRaw.projectID === "string" ? sessionRaw.projectID : undefined;
  if (!cwd && projectID) {
    const proj = await readJson(
      join(storageRoot, "project", `${projectID}.json`),
    );
    if (proj && typeof proj.worktree === "string") cwd = proj.worktree;
  }

  // Walk parts per message, stitching text/reasoning/tool into blocks.
  const messages: ConversationMessage[] = [];

  for (const m of messageMetas) {
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

    const blocks: MessageBlock[] = [];
    for (const part of parts) {
      const type = part.type;
      if (type === "text" && typeof part.text === "string") {
        blocks.push({ kind: "text", text: part.text });
      } else if (type === "reasoning" && typeof part.text === "string") {
        blocks.push({ kind: "thinking", text: part.text });
      } else if (type === "tool") {
        const toolName = typeof part.tool === "string" ? part.tool : "tool";
        const state = part.state as Record<string, unknown> | undefined;
        const input = state?.input;
        const output = state?.output;
        const callLabel = `${toolName}(${
          input === undefined ? "" : JSON.stringify(input)
        })`;
        blocks.push({ kind: "tool_use", text: callLabel, toolName });
        if (output !== undefined) {
          const outText =
            typeof output === "string" ? output : JSON.stringify(output);
          blocks.push({ kind: "tool_result", text: outText, toolName });
        }
      }
      // step-start / step-finish are lifecycle markers; skip.
    }

    if (blocks.length === 0) continue;

    const role: ConversationMessage["role"] =
      m.role === "user"
        ? "user"
        : m.role === "assistant"
          ? "assistant"
          : m.role === "system"
            ? "system"
            : "assistant";

    messages.push({
      messageId: m.id,
      timestamp: new Date(m.createdMs).toISOString(),
      role,
      blocks,
    });
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
      : (messages[0]?.timestamp ?? sourceModifiedAt);
  const endedAt =
    updatedMs !== undefined
      ? new Date(updatedMs).toISOString()
      : (messages[messages.length - 1]?.timestamp ?? startedAt);

  if (messages.length === 0) {
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
    messages,
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
