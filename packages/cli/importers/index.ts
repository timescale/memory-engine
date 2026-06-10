/**
 * Shared orchestration for agent conversation importers.
 *
 * Each per-tool importer (claude, codex, opencode) exposes a
 * `discoverSessions` async generator that yields `ImportedSession`
 * objects. `runImport` then walks each session's `messages[]` and
 * writes one memory per message, using deterministic UUIDv7s keyed
 * by `(tool, sessionId, messageId)` so re-imports are idempotent.
 *
 * Performance shape: each session does at most two RPCs against the
 * engine — one `memory.search` to fetch existing message ids for the
 * session, and one `memory.batchCreate` for everything new. Updates
 * (only triggered by an `importer_version` bump) are issued one at a
 * time and are expected to be rare.
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
 * re-render of every previously-imported message on the next run (via
 * the version check in `planSession`) so parser changes propagate
 * without manual intervention.
 *
 * Locked at "1" during pre-release iteration — bump only after the first
 * real release so early adopters get parser fixes without a manual wipe.
 */
export const IMPORTER_VERSION = "1";

/**
 * Maximum memories per `memory.search` lookup. Same protocol limit. A
 * session with more existing messages than this triggers a fallback to
 * paged lookups (rare in practice).
 */
const SEARCH_PAGE_LIMIT = 1000;

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
 * writes only the messages after it. Falls back to the full reconcile
 * (`writeSession`) for a new session, an `importer_version` bump, a lost anchor
 * (compaction/reorder), or any fast-path write error — so correctness never
 * depends on the optimization. Returns null when the file has no session.
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
  const title = synthesizeTitle(session);

  const hw = await searchSessionHighWater(
    engine,
    tree,
    session.tool,
    session.sessionId,
  );
  if (hw && hw.importerVersion === IMPORTER_VERSION) {
    const plan = planSession(session, tree, slug, gitRoot, gitRemote, options);
    const idx = plan.planned.findIndex(
      (p) => p.message.messageId === hw.messageId,
    );
    if (idx !== -1) {
      const delta = plan.planned.slice(idx + 1);
      const outcome: SessionOutcome = {
        sessionId: session.sessionId,
        title,
        tree,
        sourceFile: session.sourceFile,
        inserted: 0,
        updated: 0,
        skipped: plan.skipped,
        failed: plan.failed,
        errors: [...plan.errors],
      };
      if (delta.length === 0) return outcome;
      if (options.dryRun) {
        outcome.inserted += delta.length;
        return outcome;
      }
      try {
        const { insertedIds, errors } = await batchCreateChunked(
          engine,
          delta.map((d) => d.payload),
        );
        if (errors.length === 0) {
          // An already-present id (non-monotonic transcript) is silently
          // skipped server-side, so inserted may be < delta.length.
          outcome.inserted += insertedIds.length;
          return outcome;
        }
        // A failed chunk → fall through to the full reconcile for correctness.
      } catch {
        // Unexpected write error → reconcile.
      }
    }
  }

  return writeSession(
    engine,
    session,
    title,
    tree,
    slug,
    gitRoot,
    gitRemote,
    options,
  );
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

/**
 * Write all messages for one session.
 *
 * Strategy:
 *   1. One `memory.search` to fetch existing message ids + their
 *      `importer_version` for this session.
 *   2. Diff each rendered message against the existing set:
 *        - id absent       → queue for batch insert
 *        - id present, ver matches → skip
 *        - id present, ver differs → queue for update
 *   3. Issue one `memory.batchCreate` (in chunks of 1000) for inserts;
 *      updates are issued one at a time (rare path).
 */
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
  const deduped = plan.planned;

  if (deduped.length === 0) return outcome;

  // Bulk-fetch existing message ids for this session in one search.
  let existing: Map<string, string | undefined>;
  try {
    existing = await fetchExistingMessageVersions(engine, session, tree);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // The whole session fails if we can't determine existing state.
    outcome.failed += deduped.length;
    for (const p of deduped) {
      outcome.errors.push({
        messageId: p.message.messageId,
        error: `existing-state lookup failed: ${msg}`,
      });
    }
    return outcome;
  }

  const toInsert: MemoryCreateParams[] = [];
  const toUpdate: Array<{ messageId: string; payload: MemoryCreateParams }> =
    [];

  for (const p of deduped) {
    const existingVersion = existing.get(p.memoryId);
    if (existingVersion === undefined) {
      toInsert.push(p.payload);
    } else if (existingVersion === IMPORTER_VERSION) {
      outcome.skipped++;
    } else {
      toUpdate.push({ messageId: p.message.messageId, payload: p.payload });
    }
  }

  // Inserts: one batchCreate per chunk. Chunks are cut by byte budget OR
  // count cap, whichever fires first, so a chunk's serialized request body
  // stays under the server's request size limit.
  if (toInsert.length > 0) {
    if (options.dryRun) {
      outcome.inserted += toInsert.length;
    } else {
      const { insertedIds, errors } = await batchCreateChunked(
        engine,
        toInsert,
      );
      outcome.inserted += insertedIds.length;
      // Each chunk error contributes its full itemCount to `failed` and
      // attaches the same message to each id in that chunk — matching the
      // pre-chunking behavior of one error row per attempted message.
      for (const e of errors) {
        outcome.failed += e.itemCount;
        for (const id of e.ids) {
          outcome.errors.push({ messageId: id, error: e.error });
        }
      }
    }
  }

  // Updates: rare, issued one at a time.
  for (const u of toUpdate) {
    if (options.dryRun) {
      outcome.updated++;
      continue;
    }
    try {
      await engine.memory.update({
        id: u.payload.id as string,
        content: u.payload.content,
        meta: u.payload.meta,
        tree: u.payload.tree,
        temporal: u.payload.temporal,
      });
      outcome.updated++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      outcome.failed++;
      outcome.errors.push({ messageId: u.messageId, error: msg });
    }
  }

  return outcome;
}

/**
 * Fetch existing message ids + their `importer_version` for one session.
 *
 * Uses `memory.search` with a `meta` filter on `source_session_id` +
 * `source_tool`. Restricted to the session's tree so the search is
 * indexed by tree first. Returns `id → importer_version` (version is
 * `undefined` when the record was written before the field existed).
 */
async function fetchExistingMessageVersions(
  engine: MemoryClient,
  session: ImportedSession,
  tree: string,
): Promise<Map<string, string | undefined>> {
  const result = await engine.memory.search({
    tree,
    meta: {
      source_tool: session.tool,
      source_session_id: session.sessionId,
    },
    limit: SEARCH_PAGE_LIMIT,
  });
  if (result.total > result.results.length) {
    // Sessions exceeding 1000 already-imported messages would silently
    // re-insert and hit duplicate-id errors. Surface that loudly so we
    // can paginate when it actually happens.
    throw new Error(
      `session has ${result.total} existing messages but bulk-fetch is capped at ${SEARCH_PAGE_LIMIT}; pagination not yet implemented`,
    );
  }
  const map = new Map<string, string | undefined>();
  for (const r of result.results) {
    const v = r.meta.importer_version;
    map.set(r.id, typeof v === "string" ? v : undefined);
  }
  return map;
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
