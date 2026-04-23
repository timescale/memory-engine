/**
 * Shared orchestration for agent conversation importers.
 *
 * Each per-tool importer (claude, codex, opencode) exposes a
 * `discoverSessions` async generator that yields `ImportedSession`
 * objects. `runImport` then walks each session's `messages[]` and
 * writes one memory per message, using deterministic UUIDv7s keyed
 * by `(tool, sessionId, messageId)` so that re-imports are idempotent.
 */
import type { EngineClient } from "@memory.build/client";
import { isRpcError } from "@memory.build/client";
import type { MemoryResponse } from "@memory.build/protocol/engine";
import type { ProgressReporter } from "./progress.ts";
import { SlugRegistry } from "./slug.ts";
import { renderMessageContent, synthesizeTitle } from "./transcript.ts";
import type {
  ConversationMessage,
  ImportedSession,
  ImporterOptions,
  ImporterStats,
} from "./types.ts";
import { deterministicMessageUuidV7 } from "./uuid.ts";

/**
 * Version tag stored in `meta.importer_version`. Bumping this forces a
 * re-render of every previously-imported message on the next run (via
 * the version check in `writeMessage`) so parser changes propagate
 * without manual intervention.
 *
 * Locked at "1" during pre-release iteration — bump only after the first
 * real release so early adopters get parser fixes without a manual wipe.
 */
export const IMPORTER_VERSION = "1";

/** An importer's discovery interface — yields normalized sessions. */
export interface Importer {
  tool: ImportedSession["tool"];
  defaultSource: string;
  discoverSessions(
    options: ImporterOptions,
    stats: ImporterStats,
    progress?: ProgressReporter,
  ): AsyncIterable<ImportedSession>;
}

/** Result of the orchestration pass. */
export interface ImportResult {
  /** Sessions whose messages were processed. */
  sessionsProcessed: number;
  /** Messages newly inserted as memories. */
  inserted: number;
  /** Messages updated (importer version mismatch). */
  updated: number;
  /** Messages skipped (already present and up-to-date, or empty content). */
  skipped: number;
  /** Messages that failed to write. */
  failed: number;
  /** Per-session outcomes in discovery order. */
  outcomes: Array<SessionOutcome>;
  /** Stats from the discovery phase. */
  discovery: ImporterStats;
  /** Any collisions resolved by the slug registry. */
  slugCollisions: ReturnType<SlugRegistry["collisions"]>;
}

/** Per-session outcome aggregating per-message counts. */
export interface SessionOutcome {
  sessionId: string;
  title: string;
  tree: string;
  sourceFile?: string;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  /** Per-message error details, if any. */
  errors: Array<{ messageId: string; error: string }>;
}

/** Options that affect writing sessions to the engine. */
export interface WriteOptions {
  /** Tree root (ltree-safe, no trailing dot). Default: projects. */
  treeRoot: string;
  /** Include full transcript (reasoning/tool calls) in message memories. */
  fullTranscript: boolean;
  /** Don't write anything — just report what would happen. */
  dryRun: boolean;
  /** Verbose per-session logging. */
  verbose: boolean;
}

/**
 * Run discovery + writes for a single importer.
 */
export async function runImport(
  engine: EngineClient,
  importer: Importer,
  importerOptions: ImporterOptions,
  writeOptions: WriteOptions,
  progress?: ProgressReporter,
): Promise<ImportResult> {
  const stats: ImporterStats = {
    totalFiles: 0,
    yielded: 0,
    skipped: {},
    errors: [],
  };
  const slugs = new SlugRegistry();
  const outcomes: SessionOutcome[] = [];
  let sessionsProcessed = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for await (const session of importer.discoverSessions(
    importerOptions,
    stats,
    progress,
  )) {
    const title = synthesizeTitle(session);
    progress?.process(title);
    sessionsProcessed++;

    const { slug, gitRoot, gitRemote } = await slugs.resolve(session.cwd);
    const tree = `${writeOptions.treeRoot}.${slug}.sessions`;

    const outcome: SessionOutcome = {
      sessionId: session.sessionId,
      title,
      tree,
      sourceFile: session.sourceFile,
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };

    for (const message of session.messages) {
      const content = renderMessageContent(message, {
        fullTranscript: writeOptions.fullTranscript,
      });
      if (content === null) {
        outcome.skipped++;
        skipped++;
        continue;
      }
      try {
        const action = await writeMessage(
          engine,
          session,
          message,
          content,
          tree,
          slug,
          gitRoot,
          gitRemote,
          writeOptions,
        );
        switch (action) {
          case "inserted":
            outcome.inserted++;
            inserted++;
            break;
          case "updated":
            outcome.updated++;
            updated++;
            break;
          case "skipped":
            outcome.skipped++;
            skipped++;
            break;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        outcome.failed++;
        failed++;
        outcome.errors.push({ messageId: message.messageId, error: msg });
      }
    }

    outcomes.push(outcome);
    if (writeOptions.verbose) {
      logOutcome(outcome, progress);
    }
  }

  return {
    sessionsProcessed,
    inserted,
    updated,
    skipped,
    failed,
    outcomes,
    discovery: stats,
    slugCollisions: slugs.collisions(),
  };
}

/**
 * Write a single message — insert, update, or skip based on current state.
 *
 * Returns the action taken so the caller can bump its counters.
 */
async function writeMessage(
  engine: EngineClient,
  session: ImportedSession,
  message: ConversationMessage,
  content: string,
  tree: string,
  projectSlug: string,
  gitRoot: string | undefined,
  gitRemote: string | undefined,
  options: WriteOptions,
): Promise<"inserted" | "updated" | "skipped"> {
  const timestampMs = Number(Date.parse(message.timestamp));
  if (Number.isNaN(timestampMs)) {
    throw new Error(
      `invalid message timestamp: ${message.timestamp} (message ${message.messageId})`,
    );
  }

  const memoryId = deterministicMessageUuidV7(
    session.tool,
    session.sessionId,
    message.messageId,
    timestampMs,
  );
  const meta = buildMeta(
    session,
    message,
    projectSlug,
    gitRoot,
    gitRemote,
    options,
  );
  const temporal = { start: new Date(timestampMs).toISOString() };

  const existing = await safeGetMemory(engine, memoryId);

  if (existing === null) {
    if (options.dryRun) return "inserted";
    await engine.memory.create({
      id: memoryId,
      content,
      meta,
      tree,
      temporal,
    });
    return "inserted";
  }

  // Existing memory found. Skip unless the importer version has changed.
  const existingVersion = extractMetaString(existing.meta, "importer_version");
  if (existingVersion === IMPORTER_VERSION) {
    return "skipped";
  }
  if (options.dryRun) return "updated";
  await engine.memory.update({
    id: memoryId,
    content,
    meta,
    tree,
    temporal,
  });
  return "updated";
}

/** `memory.get` wrapper that returns null on NOT_FOUND instead of throwing. */
async function safeGetMemory(
  engine: EngineClient,
  id: string,
): Promise<MemoryResponse | null> {
  try {
    return await engine.memory.get({ id });
  } catch (error) {
    if (isRpcError(error) && error.is("NOT_FOUND")) return null;
    throw error;
  }
}

/** Build the full meta object for one message memory. */
function buildMeta(
  session: ImportedSession,
  message: ConversationMessage,
  projectSlug: string,
  gitRoot: string | undefined,
  gitRemote: string | undefined,
  options: WriteOptions,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    type: "agent_session",
    source_tool: session.tool,
    source_session_id: session.sessionId,
    source_message_id: message.messageId,
    source_message_role: message.role,
    source_message_block_kinds: message.blocks.map((b) => b.kind),
    source_project_slug: projectSlug,
    source_file: session.sourceFile,
    content_mode: options.fullTranscript ? "full_transcript" : "default",
    imported_at: new Date().toISOString(),
    importer_version: IMPORTER_VERSION,
  };

  if (session.title) meta.source_session_title = session.title;
  if (session.cwd) meta.source_cwd = session.cwd;
  if (gitRoot && gitRoot !== session.cwd) meta.source_git_root = gitRoot;
  if (session.gitBranch) meta.source_git_branch = session.gitBranch;
  if (session.gitCommit) meta.source_git_commit = session.gitCommit;
  if (session.gitRepo || gitRemote) {
    meta.source_git_repo = session.gitRepo ?? gitRemote;
  }
  if (session.toolVersion) meta.source_tool_version = session.toolVersion;
  if (session.model) meta.source_model = session.model;
  if (session.provider) meta.source_provider = session.provider;
  if (session.agentMode) meta.source_agent_mode = session.agentMode;
  if (session.isSidechain) meta.source_is_sidechain = true;
  if (message.toolName) meta.source_tool_name = message.toolName;

  return meta;
}

/** Extract a string meta field if present. */
function extractMetaString(
  meta: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = meta[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Log a single session outcome (verbose mode). Routed through
 * `progress.log` when a reporter is active so the live line isn't clobbered.
 */
function logOutcome(
  outcome: SessionOutcome,
  progress?: ProgressReporter,
): void {
  const short = outcome.sessionId.slice(0, 8);
  const stats = `+${outcome.inserted} ~${outcome.updated} ·${outcome.skipped}${
    outcome.failed > 0 ? ` ✗${outcome.failed}` : ""
  }`;
  const line = `  ${short} ${outcome.title}  ${stats}`;
  if (progress) progress.log(line);
  else console.log(line);
  if (outcome.errors.length > 0) {
    for (const err of outcome.errors) {
      const errLine = `      ✗ ${err.messageId}: ${err.error}`;
      if (progress) progress.log(errLine);
      else console.log(errLine);
    }
  }
}

export type { ProgressReporter } from "./progress.ts";
export { createProgressReporter } from "./progress.ts";
export { SlugRegistry } from "./slug.ts";
export { synthesizeTitle } from "./transcript.ts";
export { deterministicMessageUuidV7 } from "./uuid.ts";
