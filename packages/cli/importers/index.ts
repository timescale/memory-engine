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

import type { MemoryCreateParams } from "@memory.build/protocol/engine";
import type { EngineClient } from "../client.ts";
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
 * Hard cap on memories per `memory.batchCreate` call (matches the protocol
 * limit). Sessions with more messages than this are split into chunks.
 */
const BATCH_CREATE_CHUNK = 1000;

/**
 * Soft byte budget per `memory.batchCreate` request body.
 *
 * The server caps request bodies at 1 MiB by default
 * (`packages/server/middleware/size-limit.ts`). With a count-only cap of 1000,
 * a single chunk of moderately-sized assistant messages routinely exceeds
 * 1 MiB and the request is rejected with HTTP 413 — taking the entire chunk
 * down with it. We instead cut chunks early when their estimated wire size
 * approaches a budget that leaves room for the JSON-RPC envelope plus headers.
 *
 * 768 KiB leaves ~256 KiB of headroom under the 1 MiB default server limit.
 * A single memory larger than the budget still gets sent in its own
 * singleton chunk; if the server rejects it, the per-chunk catch records
 * the failure without affecting siblings.
 */
const BATCH_CREATE_BYTES_BUDGET = 768 * 1024;

/**
 * Maximum memories per `memory.search` lookup. Same protocol limit. A
 * session with more existing messages than this triggers a fallback to
 * paged lookups (rare in practice).
 */
const SEARCH_PAGE_LIMIT = 1000;

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
async function writeSession(
  engine: EngineClient,
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

  // Build the per-message write payloads up front so we can plan the
  // batch in one pass and skip any messages that render to empty
  // content under the chosen mode.
  const planned: Array<{
    message: ConversationMessage;
    memoryId: string;
    payload: MemoryCreateParams;
  }> = [];

  for (const message of session.messages) {
    const content = renderMessageContent(message, {
      fullTranscript: options.fullTranscript,
    });
    if (content === null) {
      outcome.skipped++;
      continue;
    }
    const timestampMs = Number(Date.parse(message.timestamp));
    if (Number.isNaN(timestampMs)) {
      outcome.failed++;
      outcome.errors.push({
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
      payload: {
        id: memoryId,
        content,
        meta,
        tree,
        temporal,
      },
    });
  }

  // A session JSONL can contain two events that share the same `event.uuid`
  // (resume artefacts, sidechain merges, replay wrappers). The deterministic
  // UUIDv7 is keyed on (tool, sessionId, messageId), so duplicates collapse
  // to the same id and would otherwise hit the unique constraint server-side
  // — taking the whole batch's transaction down with them. Drop them here.
  const dedup = dedupByMemoryId(planned);
  outcome.skipped += dedup.duplicates;
  const deduped = dedup.unique;

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
      for (const chunk of chunkByBytes(
        toInsert,
        BATCH_CREATE_BYTES_BUDGET,
        BATCH_CREATE_CHUNK,
        approxMemoryBytes,
      )) {
        try {
          await engine.memory.batchCreate({ memories: chunk });
          outcome.inserted += chunk.length;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          outcome.failed += chunk.length;
          for (const c of chunk) {
            outcome.errors.push({
              messageId: c.id ?? "(unknown)",
              error: msg,
            });
          }
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
  engine: EngineClient,
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
 * a fake EngineClient. Used by `writeSession` to absorb sessions whose
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

/**
 * Approximate the wire size of a single `MemoryCreateParams` when it lands
 * inside a JSON-RPC `memory.batchCreate` request. Accurate enough for
 * chunking decisions; we don't need to model the envelope exactly.
 */
export function approxMemoryBytes(m: MemoryCreateParams): number {
  return JSON.stringify(m).length;
}

/**
 * Split `items` into chunks where each chunk's summed `size(item)` stays
 * under `byteBudget`, capped at `countCap` items per chunk. An item whose
 * own size exceeds the budget gets its own singleton chunk so the caller
 * can still attempt it (and fail loudly server-side, rather than silently
 * dropping it client-side).
 *
 * Exported for unit testing.
 */
export function* chunkByBytes<T>(
  items: T[],
  byteBudget: number,
  countCap: number,
  size: (item: T) => number,
): Generator<T[]> {
  let chunk: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const itemBytes = size(item);
    const wouldOverflow = chunk.length > 0 && bytes + itemBytes > byteBudget;
    const atCountCap = chunk.length >= countCap;
    if (wouldOverflow || atCountCap) {
      yield chunk;
      chunk = [];
      bytes = 0;
    }
    chunk.push(item);
    bytes += itemBytes;
  }
  if (chunk.length > 0) yield chunk;
}

export type { ProgressReporter } from "./progress.ts";
export { createProgressReporter } from "./progress.ts";
export { SlugRegistry } from "./slug.ts";
export { synthesizeTitle } from "./transcript.ts";
export { deterministicMessageUuidV7 } from "./uuid.ts";
