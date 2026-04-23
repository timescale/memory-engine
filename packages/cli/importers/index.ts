/**
 * Shared orchestration for agent conversation importers.
 *
 * Each per-tool importer (claude, codex, opencode) exposes a
 * `discoverSessions` async generator that yields `ImportedSession`
 * objects. `runImport` turns those into memories in the active engine,
 * using deterministic UUIDv7s keyed by `(tool, sessionId)` so that
 * re-imports are idempotent (or update-in-place when the session has
 * grown since the last import).
 */
import * as clack from "@clack/prompts";
import type { EngineClient } from "@memory.build/client";
import { isRpcError } from "@memory.build/client";
import type { MemoryResponse } from "@memory.build/protocol/engine";
import type { ProgressReporter } from "./progress.ts";
import { SlugRegistry } from "./slug.ts";
import { renderSessionContent, synthesizeTitle } from "./transcript.ts";
import type {
  ImportedSession,
  ImporterOptions,
  ImporterStats,
} from "./types.ts";
import { deterministicUuidV7 } from "./uuid.ts";

/**
 * Version tag stored in `meta.importer_version`. Bumping this forces a
 * re-render of every previously-imported session on the next run (via
 * `writeSession`'s version check) so parser changes propagate without
 * manual intervention.
 *
 * Version history:
 *   1 — initial release
 *   2 — claude: drop SDK wrapper cycles (synthetic assistant + replay user)
 *   3 — claude: unwrap SDK replay bundles in user text blocks (Assistant:/
 *       Human:/[Assistant:...] prefixed content from programmatic SDK runs)
 *   4 — claude: also unwrap "You are ..." system-prompt bundles (seen in
 *       opencode-claude-max-proxy and similar Claude-backend proxies)
 */
export const IMPORTER_VERSION = "4";

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
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  /** Per-session outcomes in discovery order. */
  outcomes: Array<SessionOutcome>;
  /** Stats from the discovery phase. */
  discovery: ImporterStats;
  /** Any collisions resolved by the slug registry. */
  slugCollisions: ReturnType<SlugRegistry["collisions"]>;
}

/** Per-session outcome. */
export interface SessionOutcome {
  sessionId: string;
  memoryId: string;
  tree: string;
  action: "inserted" | "updated" | "skipped" | "failed";
  reason?: string;
  title: string;
  /** Source file path of the session (for diagnostics). */
  sourceFile?: string;
}

/** Options that affect writing sessions to the engine. */
export interface WriteOptions {
  /** Tree root (ltree-safe, no trailing dot). Default: agent_conversations. */
  treeRoot: string;
  /** If true, put all sessions directly under `treeRoot` (no project subnode). */
  flat: boolean;
  /** Include full transcript (reasoning/tool calls) in the memory body. */
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
    try {
      const outcome = await writeSession(engine, session, slugs, writeOptions);
      outcomes.push(outcome);
      switch (outcome.action) {
        case "inserted":
          inserted++;
          break;
        case "updated":
          updated++;
          break;
        case "skipped":
          skipped++;
          break;
        case "failed":
          failed++;
          break;
      }
      if (writeOptions.verbose) {
        logOutcome(outcome, progress);
      }
    } catch (error) {
      failed++;
      const msg = error instanceof Error ? error.message : String(error);
      const startedAtMs = Number(Date.parse(session.startedAt)) || Date.now();
      const memoryId = deterministicUuidV7(
        session.tool,
        session.sessionId,
        startedAtMs,
      );
      outcomes.push({
        sessionId: session.sessionId,
        memoryId,
        tree: "",
        action: "failed",
        reason: msg,
        title,
        sourceFile: session.sourceFile,
      });
      if (writeOptions.verbose) {
        const line = `  ✗ ${session.sessionId.slice(0, 8)} ${title} (${msg})`;
        if (progress) progress.log(line);
        else clack.log.error(line);
      }
    }
  }

  return {
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
 * Write a single session — insert, update, or skip based on current state.
 */
async function writeSession(
  engine: EngineClient,
  session: ImportedSession,
  slugs: SlugRegistry,
  options: WriteOptions,
): Promise<SessionOutcome> {
  const { slug, gitRoot, gitRemote } = await slugs.resolve(session.cwd);
  const tree = options.flat ? options.treeRoot : `${options.treeRoot}.${slug}`;
  const startMs = Number(Date.parse(session.startedAt));
  const endMs = Number(Date.parse(session.endedAt));
  if (Number.isNaN(startMs)) {
    throw new Error(`invalid startedAt: ${session.startedAt}`);
  }

  const memoryId = deterministicUuidV7(
    session.tool,
    session.sessionId,
    startMs,
  );
  const title = synthesizeTitle(session);
  const content = renderSessionContent(session, {
    fullTranscript: options.fullTranscript,
  });
  const meta = buildMeta(session, slug, gitRoot, gitRemote, options);
  const temporal = buildTemporal(startMs, endMs);

  // Check for an existing memory with this deterministic id.
  const existing = await safeGetMemory(engine, memoryId);

  if (existing === null) {
    if (options.dryRun) {
      return {
        sessionId: session.sessionId,
        memoryId,
        tree,
        action: "inserted",
        reason: "dry run",
        title,
        sourceFile: session.sourceFile,
      };
    }
    await engine.memory.create({
      id: memoryId,
      content,
      meta,
      tree,
      temporal,
    });
    return {
      sessionId: session.sessionId,
      memoryId,
      tree,
      action: "inserted",
      title,
      sourceFile: session.sourceFile,
    };
  }

  // Change detection: last_message_id identifies session growth;
  // importer_version identifies parser upgrades that re-render the same
  // underlying session differently. Either triggers an update.
  const existingLastMsgId = extractMetaString(existing.meta, "last_message_id");
  const existingVersion = extractMetaString(existing.meta, "importer_version");
  const sessionGrew = existingLastMsgId !== session.lastMessageId;
  const importerUpgraded = existingVersion !== IMPORTER_VERSION;
  if (!sessionGrew && !importerUpgraded) {
    return {
      sessionId: session.sessionId,
      memoryId,
      tree: existing.tree || tree,
      action: "skipped",
      reason: "unchanged",
      title,
      sourceFile: session.sourceFile,
    };
  }

  const updateReason = sessionGrew ? "new messages" : "importer upgraded";

  if (options.dryRun) {
    return {
      sessionId: session.sessionId,
      memoryId,
      tree,
      action: "updated",
      reason: `dry run (${updateReason})`,
      title,
      sourceFile: session.sourceFile,
    };
  }

  await engine.memory.update({
    id: memoryId,
    content,
    meta,
    tree,
    temporal,
  });
  return {
    sessionId: session.sessionId,
    memoryId,
    tree,
    action: "updated",
    reason: updateReason,
    title,
    sourceFile: session.sourceFile,
  };
}

/**
 * `memory.get` wrapper that returns null on NOT_FOUND instead of throwing.
 */
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

/**
 * Build the temporal range for a session.
 * - Point-in-time when start == end (or no end available).
 * - Range [start, end) otherwise.
 */
function buildTemporal(
  startMs: number,
  endMs: number,
): { start: string; end?: string } {
  const start = new Date(startMs).toISOString();
  if (!Number.isFinite(endMs) || endMs <= startMs) {
    return { start };
  }
  return { start, end: new Date(endMs).toISOString() };
}

/**
 * Build the full meta object for a session memory.
 */
function buildMeta(
  session: ImportedSession,
  projectSlug: string,
  gitRoot: string | undefined,
  gitRemote: string | undefined,
  options: WriteOptions,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    type: "agent_conversation",
    source_tool: session.tool,
    source_session_id: session.sessionId,
    source_project_slug: projectSlug,
    source_file: session.sourceFile,
    last_message_id: session.lastMessageId,
    last_message_at: session.endedAt,
    message_counts: session.messageCounts,
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
  if (session.tokens) meta.tokens = session.tokens;
  if (session.costUsd !== undefined) meta.cost_usd = session.costUsd;
  if (session.isSidechain) meta.source_is_sidechain = true;

  return meta;
}

/**
 * Extract a string meta field if present.
 */
function extractMetaString(
  meta: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = meta[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Log a single outcome (verbose mode). Routed through `progress.log`
 * when a reporter is active so the live line isn't clobbered.
 */
function logOutcome(
  outcome: SessionOutcome,
  progress?: ProgressReporter,
): void {
  const short = outcome.sessionId.slice(0, 8);
  const reason = outcome.reason ? ` (${outcome.reason})` : "";
  const marker = {
    inserted: "+",
    updated: "~",
    skipped: "·",
    failed: "✗",
  }[outcome.action];
  const line = `  ${marker} ${short} ${outcome.title}${reason}`;
  if (progress) progress.log(line);
  else console.log(line);
}

export type { ProgressReporter } from "./progress.ts";
export { createProgressReporter } from "./progress.ts";
export { SlugRegistry } from "./slug.ts";
export { synthesizeTitle } from "./transcript.ts";
export { deterministicUuidV7 } from "./uuid.ts";
