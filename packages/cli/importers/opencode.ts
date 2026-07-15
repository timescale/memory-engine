/**
 * OpenCode conversation importer.
 *
 * Older OpenCode releases stored sessions across four JSON directory trees:
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
 * Current OpenCode releases store the same logical records in SQLite at
 * `~/.local/share/opencode/opencode.db` (`project`, `session`, `message`, and
 * `part` tables). Both layouts are normalized into the same shape here.
 *
 * Each `msg_<id>` becomes one `ConversationMessage`, and its parts become
 * the message's ordered blocks. A `tool` part expands into two blocks
 * (one `tool_use` for the call, one `tool_result` for the output) inside
 * the same message.
 */

import { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

const DEFAULT_SOURCE = join(homedir(), ".local", "share", "opencode");

const DEFAULT_LEGACY_STORAGE = join(DEFAULT_SOURCE, "storage");

type OpenCodeSource =
  | { kind: "sqlite"; dbPath: string }
  | { kind: "legacy"; storageRoot: string };

interface MessageMeta {
  id: string;
  role: string;
  createdMs: number;
  model?: string;
  providerID?: string;
  agent?: string;
}

interface SqliteProjectRow {
  id: string;
  worktree: string | null;
}

interface SqliteSessionRow {
  id: string;
  project_id: string;
  directory: string | null;
  title: string | null;
  version: string | null;
  agent: string | null;
  model: string | null;
  time_created: number;
  time_updated: number;
}

interface SqliteMessageRow {
  id: string;
  time_created: number;
  data: string;
}

interface SqlitePartRow {
  id: string;
  message_id: string;
  time_created: number;
  data: string;
}

export const opencodeImporter: Importer = {
  tool: "opencode",
  defaultSource: DEFAULT_SOURCE,
  discoverSessions,
  parseFile: parseSessionFile,
};

/**
 * Parse a single OpenCode session file into one session — the live-capture path
 * used by `me opencode hook`. The storage root is the `storage/` ancestor three
 * levels up from the session file (`<storageRoot>/session/<projectID>/ses_<id>.json`),
 * so the per-message/per-part directories resolve the same way bulk import does.
 */
async function parseSessionFile(file: string): Promise<ImportedSession | null> {
  const storageRoot = dirname(dirname(dirname(file)));
  return parseLegacySession(file, storageRoot);
}

/**
 * Parse one OpenCode session by id from either the current SQLite DB or the
 * legacy JSON storage tree. Used by `me opencode hook`, which receives only a
 * session id from the generated plugin.
 */
export async function parseSessionById(
  sessionId: string,
  source: string = DEFAULT_SOURCE,
): Promise<ImportedSession | null> {
  const resolved = await resolveOpenCodeSource(source);
  if (!resolved) return null;
  if (resolved.kind === "sqlite") {
    return parseSqliteSessionById(resolved.dbPath, sessionId);
  }
  const file = await resolveSessionFile(sessionId, resolved.storageRoot);
  return file ? parseLegacySession(file, resolved.storageRoot) : null;
}

/**
 * Locate a session file by its id within an OpenCode storage tree. Session files
 * live at `<storage>/session/<projectID>/ses_<id>.json`, nested under a project
 * dir, so the id alone needs a lookup across project dirs. Returns the absolute
 * path, or null when no session with that id exists. Used by `me opencode hook`,
 * which receives a session id from the plugin (not a file path).
 */
export async function resolveSessionFile(
  sessionId: string,
  storage: string = DEFAULT_LEGACY_STORAGE,
): Promise<string | null> {
  const sessionRoot = join(storage, "session");
  let projectDirs: string[];
  try {
    projectDirs = await listSubdirs(sessionRoot);
  } catch {
    return null;
  }
  const fileName = `${sessionId}.json`;
  for (const projectDir of projectDirs) {
    const candidate = join(projectDir, fileName);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // not in this project dir; keep scanning.
    }
  }
  return null;
}

async function* discoverSessions(
  options: ImporterOptions,
  stats: ImporterStats,
  progress?: ProgressReporter,
): AsyncIterable<ImportedSession> {
  const source = await resolveOpenCodeSource(options.source ?? DEFAULT_SOURCE);
  if (!source) return;

  if (source.kind === "sqlite") {
    yield* discoverSqliteSessions(source.dbPath, options, stats, progress);
    return;
  }

  const storage = source.storageRoot;
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
        session = await parseLegacySession(sessionFile, storage);
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
      const skip = filterSession(session, options);
      if (skip) {
        recordSkip(stats, skip);
        continue;
      }
      stats.yielded++;
      yield session;
    }
  }
}

async function resolveOpenCodeSource(
  source: string,
): Promise<OpenCodeSource | null> {
  const stat = await fs.stat(source).catch(() => null);
  if (stat?.isFile()) return { kind: "sqlite", dbPath: source };
  if (!stat?.isDirectory()) return null;

  const dbPath = join(source, "opencode.db");
  if (await isFile(dbPath)) return { kind: "sqlite", dbPath };

  if (await isDirectory(join(source, "session"))) {
    return { kind: "legacy", storageRoot: source };
  }
  if (await isDirectory(join(source, "storage", "session"))) {
    return { kind: "legacy", storageRoot: join(source, "storage") };
  }
  if (
    source === DEFAULT_SOURCE &&
    (await isDirectory(join(DEFAULT_LEGACY_STORAGE, "session")))
  ) {
    return { kind: "legacy", storageRoot: DEFAULT_LEGACY_STORAGE };
  }
  return null;
}

async function isFile(path: string): Promise<boolean> {
  const stat = await fs.stat(path).catch(() => null);
  return stat?.isFile() ?? false;
}

async function isDirectory(path: string): Promise<boolean> {
  const stat = await fs.stat(path).catch(() => null);
  return stat?.isDirectory() ?? false;
}

function filterSession(
  session: ImportedSession,
  options: ImporterOptions,
): ReturnType<typeof filterBySessionShape> {
  return filterBySessionShape(
    {
      startedAt: session.startedAt,
      userMessageCount: countUserMessages(session.messages),
      cwd: session.cwd,
    },
    options,
  );
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
async function parseLegacySession(
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

    const msgModel = modelId(raw);
    const msgProvider = providerId(raw);
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

    const blocks = blocksFromParts(m.role, parts);
    if (blocks.length === 0) continue;

    messages.push({
      messageId: m.id,
      timestamp: new Date(m.createdMs).toISOString(),
      role: normalizeRole(m.role),
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

async function* discoverSqliteSessions(
  dbPath: string,
  options: ImporterOptions,
  stats: ImporterStats,
  progress?: ProgressReporter,
): AsyncIterable<ImportedSession> {
  const db = new Database(dbPath, { readonly: true, strict: true });
  try {
    const rows = db
      .query<SqliteSessionRow, []>(
        `select id, project_id, directory, title, version, agent, model,
                time_created, time_updated
           from session
          order by time_created, id`,
      )
      .all();
    for (const row of rows) {
      stats.totalFiles++;
      const source = sqliteSourceFile(dbPath, row.id);
      progress?.scan(source);
      let session: ImportedSession | null;
      try {
        session = parseSqliteSession(db, dbPath, row);
      } catch (error) {
        stats.errors.push({
          source,
          error: error instanceof Error ? error.message : String(error),
        });
        recordSkip(stats, "parse_error");
        continue;
      }
      if (!session) {
        recordSkip(stats, "empty");
        continue;
      }
      const skip = filterSession(session, options);
      if (skip) {
        recordSkip(stats, skip);
        continue;
      }
      stats.yielded++;
      yield session;
    }
  } finally {
    db.close();
  }
}

function parseSqliteSessionById(
  dbPath: string,
  sessionId: string,
): ImportedSession | null {
  const db = new Database(dbPath, { readonly: true, strict: true });
  try {
    const row = db
      .query<SqliteSessionRow, [string]>(
        `select id, project_id, directory, title, version, agent, model,
                time_created, time_updated
           from session
          where id = ?`,
      )
      .get(sessionId);
    return row ? parseSqliteSession(db, dbPath, row) : null;
  } finally {
    db.close();
  }
}

function parseSqliteSession(
  db: Database,
  dbPath: string,
  row: SqliteSessionRow,
): ImportedSession | null {
  const project = db
    .query<SqliteProjectRow, [string]>(
      "select id, worktree from project where id = ?",
    )
    .get(row.project_id);
  const messageRows = db
    .query<SqliteMessageRow, [string]>(
      `select id, time_created, data
         from message
        where session_id = ?
        order by time_created, id`,
    )
    .all(row.id);
  const partRows = db
    .query<SqlitePartRow, [string]>(
      `select id, message_id, time_created, data
         from part
        where session_id = ?
        order by message_id, time_created, id`,
    )
    .all(row.id);

  const partsByMessage = new Map<
    string,
    Array<{ createdMs: number; part: Record<string, unknown> }>
  >();
  for (const partRow of partRows) {
    const part = parseJsonText(partRow.data);
    if (!part) continue;
    const list = partsByMessage.get(partRow.message_id) ?? [];
    list.push({ createdMs: partCreatedMs(part, partRow.time_created), part });
    partsByMessage.set(partRow.message_id, list);
  }
  for (const parts of partsByMessage.values()) {
    parts.sort((a, b) => a.createdMs - b.createdMs);
  }

  const messages: ConversationMessage[] = [];
  let model: string | undefined;
  let provider: string | undefined;
  let agentMode = row.agent ?? undefined;
  const sessionModel = parseJsonText(row.model ?? undefined);
  if (sessionModel) {
    model = modelId(sessionModel);
    provider = providerId(sessionModel);
  }

  for (const messageRow of messageRows) {
    const raw = parseJsonText(messageRow.data);
    if (!raw) continue;
    const role = typeof raw.role === "string" ? raw.role : undefined;
    if (!role) continue;
    const createdMs = messageCreatedMs(raw, messageRow.time_created);
    const msgModel = modelId(raw);
    const msgProvider = providerId(raw);
    const agent = typeof raw.agent === "string" ? raw.agent : undefined;
    if (!model && msgModel) model = msgModel;
    if (!provider && msgProvider) provider = msgProvider;
    if (!agentMode && agent) agentMode = agent;

    const meta: MessageMeta = {
      id: messageRow.id,
      role,
      createdMs,
      model: msgModel,
      providerID: msgProvider,
      agent,
    };
    const parts = (partsByMessage.get(messageRow.id) ?? []).map((p) => p.part);
    const blocks = blocksFromParts(meta.role, parts);
    if (blocks.length === 0) continue;
    messages.push({
      messageId: meta.id,
      timestamp: new Date(meta.createdMs).toISOString(),
      role: normalizeRole(meta.role),
      blocks,
    });
  }

  if (messages.length === 0) return null;

  const sourceModifiedAt = new Date(row.time_updated).toISOString();
  return {
    tool: "opencode",
    sessionId: row.id,
    title: row.title ?? undefined,
    cwd: row.directory ?? project?.worktree ?? undefined,
    toolVersion: row.version ?? undefined,
    model,
    provider,
    agentMode,
    sourceFile: sqliteSourceFile(dbPath, row.id),
    startedAt: new Date(row.time_created).toISOString(),
    endedAt: new Date(row.time_updated).toISOString(),
    sourceModifiedAt,
    messages,
  };
}

function sqliteSourceFile(dbPath: string, sessionId: string): string {
  return `${dbPath}#session/${sessionId}`;
}

function parseJsonText(
  text: string | undefined,
): Record<string, unknown> | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
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

function isSyntheticOpenCodeMetaPart(
  role: string,
  part: Record<string, unknown>,
): boolean {
  return role === "user" && part.type === "text" && part.synthetic === true;
}

function blocksFromParts(
  role: string,
  parts: Array<Record<string, unknown>>,
): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  for (const part of parts) {
    const type = part.type;
    if (isSyntheticOpenCodeMetaPart(role, part)) continue;
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
    // step-start / step-finish and other OpenCode lifecycle/artifact parts skip.
  }
  return blocks;
}

function normalizeRole(role: string): ConversationMessage["role"] {
  return role === "user"
    ? "user"
    : role === "assistant"
      ? "assistant"
      : role === "system"
        ? "system"
        : "assistant";
}

function modelId(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.modelID === "string") return raw.modelID;
  if (typeof raw.id === "string" && typeof raw.providerID === "string") {
    return raw.id;
  }
  const model = raw.model as Record<string, unknown> | undefined;
  if (typeof model?.modelID === "string") return model.modelID;
  if (typeof model?.id === "string") return model.id;
  return undefined;
}

function providerId(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.providerID === "string") return raw.providerID;
  const model = raw.model as Record<string, unknown> | undefined;
  if (typeof model?.providerID === "string") return model.providerID;
  return undefined;
}

function messageCreatedMs(
  raw: Record<string, unknown>,
  fallback: number,
): number {
  const time = raw.time as Record<string, unknown> | undefined;
  return typeof time?.created === "number" ? time.created : fallback;
}

function partCreatedMs(part: Record<string, unknown>, fallback = 0): number {
  const time = part.time as Record<string, unknown> | undefined;
  const start = time?.start ?? time?.created;
  return typeof start === "number" ? start : fallback;
}
