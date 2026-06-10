/**
 * Shared orchestration for agent conversation importers.
 *
 * Each per-tool importer (claude, codex, opencode) exposes a
 * `discoverSessions` async generator that yields `ImportedSession`
 * objects. `runImport` then walks each session's `messages[]` and
 * writes one memory per message, using deterministic UUIDv7s keyed
 * by `(tool, sessionId, messageId)` so re-imports are idempotent.
 *
 * Reconciliation happens server-side: every planned message is submitted
 * through the conditional upsert (`memory.batchCreate` with
 * `replaceIfMetaDiffers: "importer_version"`) — new ids insert, rows whose
 * stored `importer_version` differs are rewritten in place, and
 * already-current rows are skipped, all classified from the batch
 * response. No existing-state pre-fetch, so sessions of any size (including
 * past the 1000-row search page) reconcile exactly. Per session that is
 * ceil(n/chunk) `memory.batchCreate` calls; the live-capture hook adds one
 * `memory.search` to narrow the submission to the new suffix.
 */

import type { MemoryCreateParams } from "@memory.build/protocol/memory";
import { batchCreateChunked } from "../chunk.ts";
import type { MemoryClient } from "../client.ts";
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
 * re-render of every previously-imported message on the next run: the
 * server's conditional upsert replaces any row whose stored value for
 * `IMPORTER_VERSION_KEY` differs from the submitted one, so parser changes
 * propagate without manual intervention.
 *
 * Locked at "1" during pre-release iteration — bump only after the first
 * real release so early adopters get parser fixes without a manual wipe.
 */
export const IMPORTER_VERSION = "1";

/** The meta key the server compares for the conditional replace. */
const IMPORTER_VERSION_KEY = "importer_version";

/**
 * Default capture layout, shared by `me import claude` and the Claude Code capture
 * hook so live + imported sessions land in the same place:
 * `<DEFAULT_TREE_ROOT>.<project_slug>.<DEFAULT_SESSIONS_NODE_NAME>`. Under
 * `share` so a session-authenticated user (owner@share, not arbitrary top-level
 * paths) can write there.
 */
export const DEFAULT_TREE_ROOT = "share.projects";
export const DEFAULT_SESSIONS_NODE_NAME = "agent_sessions";

/** An importer's discovery interface — yields normalized sessions. */
export interface Importer {
  tool: ImportedSession["tool"];
  defaultSource: string;
  discoverSessions(
    options: ImporterOptions,
    stats: ImporterStats,
    progress?: ProgressReporter,
  ): AsyncIterable<ImportedSession>;
  /**
   * Parse a single transcript file into one session (or null if empty / no
   * messages). Used by the live capture hook (`importTranscriptFile`); only the
   * Claude importer implements it for now.
   */
  parseFile?(path: string): Promise<ImportedSession | null>;
}

/** Result of the orchestration pass. */
export interface ImportResult {
  sessionsProcessed: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  outcomes: Array<SessionOutcome>;
  discovery: ImporterStats;
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
  errors: Array<{ messageId: string; error: string }>;
}

/** Options that affect writing sessions to the engine. */
export interface WriteOptions {
  /** Tree root (ltree-safe, no trailing dot). Default: projects. */
  treeRoot: string;
  /** Per-project node name for imported agent sessions. */
  sessionsNodeName: string;
  /** Include full transcript (reasoning/tool calls) in message memories. */
  fullTranscript: boolean;
  /** Don't write anything — just report what would happen. */
  dryRun: boolean;
  /** Verbose per-session logging. */
  verbose: boolean;
}

/** Run discovery + writes for a single importer. */
export async function runImport(
  engine: MemoryClient,
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
    const tree = `${writeOptions.treeRoot}.${slug}.${writeOptions.sessionsNodeName}`;

    const outcome = await writeSession(
      engine,
      session,
      title,
      tree,
      slug,
      gitRoot,
      gitRemote,
      writeOptions,
    );
    outcomes.push(outcome);
    inserted += outcome.inserted;
    updated += outcome.updated;
    skipped += outcome.skipped;
    failed += outcome.failed;
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
 * Import a single transcript file — the live-capture path used by the Claude
 * Code hook. Reuses the same parse + render + write as `me import claude`, so live
 * captures and bulk imports produce identical memories (tree, ids, `source_*`
 * metadata).
 *
 * Incremental + stateless: it asks the server for the session's high-water
 * message (`searchSessionHighWater` — one `limit 1`, newest-first search) and
 * submits only the messages after it. The narrowing is purely a bandwidth
 * optimization — a new session, an `importer_version` bump, or a lost anchor
 * (compaction/reorder) submits the full plan, and the server's conditional
 * upsert reconciles whatever overlaps. Returns null when the file has no
 * session.
 */
export async function importTranscriptFile(
  engine: MemoryClient,
  importer: Importer,
  filePath: string,
  options: WriteOptions,
): Promise<SessionOutcome | null> {
  if (!importer.parseFile) {
    throw new Error(
      `importer '${importer.tool}' does not support single-file parsing`,
    );
  }
  const session = await importer.parseFile(filePath);
  if (!session) return null;

  const { slug, gitRoot, gitRemote } = await new SlugRegistry().resolve(
    session.cwd,
  );
  const tree = `${options.treeRoot}.${slug}.${options.sessionsNodeName}`;

  const plan = planSession(session, tree, slug, gitRoot, gitRemote, options);
  const outcome: SessionOutcome = {
    sessionId: session.sessionId,
    title: synthesizeTitle(session),
    tree,
    sourceFile: session.sourceFile,
    inserted: 0,
    updated: 0,
    skipped: plan.skipped,
    failed: plan.failed,
    errors: [...plan.errors],
  };

  let planned = plan.planned;
  const hw = await searchSessionHighWater(
    engine,
    tree,
    session.tool,
    session.sessionId,
  );
  if (hw && hw.importerVersion === IMPORTER_VERSION) {
    const idx = planned.findIndex((p) => p.message.messageId === hw.messageId);
    if (idx !== -1) {
      // The anchor and everything before it are already imported at the
      // current version (transcripts are append-only).
      outcome.skipped += idx + 1;
      planned = planned.slice(idx + 1);
    }
  }

  await submitPlanned(engine, planned, outcome, options);
  return outcome;
}

/**
 * The session's high-water message: the latest already-imported message for
 * (tool, sessionId) under `tree`. One `memory.search` with `limit: 1` — unranked
 * search defaults to newest-first (by id, which encodes the message timestamp),
 * so results[0] is the most recent. Null when nothing is imported yet.
 */
async function searchSessionHighWater(
  engine: MemoryClient,
  tree: string,
  tool: ImportedSession["tool"],
  sessionId: string,
): Promise<{ messageId: string; importerVersion?: string } | null> {
  const res = await engine.memory.search({
    tree,
    meta: { source_tool: tool, source_session_id: sessionId },
    limit: 1,
  });
  const top = res.results[0];
  if (!top) return null;
  const messageId = top.meta.source_message_id;
  if (typeof messageId !== "string") return null;
  const v = top.meta.importer_version;
  return { messageId, importerVersion: typeof v === "string" ? v : undefined };
}

/** One planned message write (post-render, pre-dedup/diff). */
interface PlannedMessage {
  message: ConversationMessage;
  memoryId: string;
  payload: MemoryCreateParams;
}

/** Result of planning a session's writes (rendered, deduped). */
interface PlanResult {
  planned: PlannedMessage[];
  skipped: number;
  failed: number;
  errors: Array<{ messageId: string; error: string }>;
}

/**
 * Render + dedup a session's messages into write payloads (no RPCs). Skips
 * messages that render empty under the chosen mode, records bad timestamps as
 * failures, and collapses events sharing a deterministic id (resume/replay
 * artefacts) so the batch can't trip the unique constraint server-side.
 */
function planSession(
  session: ImportedSession,
  tree: string,
  projectSlug: string,
  gitRoot: string | undefined,
  gitRemote: string | undefined,
  options: WriteOptions,
): PlanResult {
  const planned: PlannedMessage[] = [];
  let skipped = 0;
  let failed = 0;
  const errors: Array<{ messageId: string; error: string }> = [];

  for (const message of session.messages) {
    const content = renderMessageContent(message, {
      fullTranscript: options.fullTranscript,
    });
    if (content === null) {
      skipped++;
      continue;
    }
    const timestampMs = Number(Date.parse(message.timestamp));
    if (Number.isNaN(timestampMs)) {
      failed++;
      errors.push({
        messageId: message.messageId,
        error: `invalid message timestamp: ${message.timestamp}`,
      });
      continue;
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
    planned.push({
      message,
      memoryId,
      payload: { id: memoryId, content, meta, tree, temporal },
    });
  }

  const dedup = dedupByMemoryId(planned);
  return {
    planned: dedup.unique,
    skipped: skipped + dedup.duplicates,
    failed,
    errors,
  };
}

/**
 * Write all messages for one session: plan + dedup, then submit everything
 * through the server's conditional upsert (see `submitPlanned`). No
 * existing-state read — classification comes from the batch response.
 */
async function writeSession(
  engine: MemoryClient,
  session: ImportedSession,
  title: string,
  tree: string,
  projectSlug: string,
  gitRoot: string | undefined,
  gitRemote: string | undefined,
  options: WriteOptions,
): Promise<SessionOutcome> {
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

  const plan = planSession(
    session,
    tree,
    projectSlug,
    gitRoot,
    gitRemote,
    options,
  );
  outcome.skipped += plan.skipped;
  outcome.failed += plan.failed;
  outcome.errors.push(...plan.errors);

  await submitPlanned(engine, plan.planned, outcome, options);
  return outcome;
}

/**
 * Submit planned messages through the conditional upsert and fold the
 * outcome into `outcome`: new ids insert, rows whose stored
 * `importer_version` differs are rewritten in place (the version-bump
 * re-render), and already-current rows are skipped — all classified from
 * the batch response, independent of how many messages the session already
 * has server-side.
 *
 * Chunks are cut by byte budget OR count cap (see batchCreateChunked) so
 * each request body stays under the server's size limit; a failed chunk
 * contributes its full itemCount to `failed` with one error row per id.
 *
 * Dry runs report every planned message as an insert — there is no server
 * classification without submitting.
 */
async function submitPlanned(
  engine: MemoryClient,
  planned: PlannedMessage[],
  outcome: SessionOutcome,
  options: WriteOptions,
): Promise<void> {
  if (planned.length === 0) return;
  if (options.dryRun) {
    outcome.inserted += planned.length;
    return;
  }

  const { insertedIds, updatedIds, errors } = await batchCreateChunked(
    engine,
    planned.map((p) => p.payload),
    { replaceIfMetaDiffers: IMPORTER_VERSION_KEY },
  );
  outcome.inserted += insertedIds.length;
  outcome.updated += updatedIds.length;
  let failedCount = 0;
  for (const e of errors) {
    failedCount += e.itemCount;
    outcome.failed += e.itemCount;
    for (const id of e.ids) {
      outcome.errors.push({ messageId: id, error: e.error });
    }
  }
  // Whatever the server neither inserted, updated, nor failed already
  // exists at the current importer_version.
  outcome.skipped +=
    planned.length - insertedIds.length - updatedIds.length - failedCount;
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
    [IMPORTER_VERSION_KEY]: IMPORTER_VERSION,
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

/**
 * Drop items whose `memoryId` has already been seen, preserving order.
 * Exported so the dedup behavior can be unit-tested without standing up
 * a fake MemoryClient. Used by `writeSession` to absorb sessions whose
 * JSONL has duplicate `event.uuid` entries (which would otherwise produce
 * two planned memories with the same deterministic UUIDv7).
 */
export function dedupByMemoryId<T extends { memoryId: string }>(
  items: T[],
): { unique: T[]; duplicates: number } {
  const seen = new Set<string>();
  const unique: T[] = [];
  let duplicates = 0;
  for (const item of items) {
    if (seen.has(item.memoryId)) {
      duplicates++;
      continue;
    }
    seen.add(item.memoryId);
    unique.push(item);
  }
  return { unique, duplicates };
}

export type { ProgressReporter } from "./progress.ts";
export { createProgressReporter } from "./progress.ts";
export { SlugRegistry } from "./slug.ts";
export { synthesizeTitle } from "./transcript.ts";
export { deterministicMessageUuidV7 } from "./uuid.ts";
