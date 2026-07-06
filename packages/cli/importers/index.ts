/**
 * Shared orchestration for agent conversation importers.
 *
 * Each per-tool importer (claude, codex, opencode) exposes a
 * `discoverSessions` async generator that yields `ImportedSession`
 * objects. `runImport` then walks each session's `messages[]` and
 * writes one memory per message, named `msg_<messageId>` under a per-session
 * tree node — so `(tree, name)` is the idempotency key and re-imports collapse
 * onto the same rows. The id is a timestamp-prefixed UUIDv7 (random tail) so
 * memories still sort chronologically by id.
 *
 * Reconciliation happens server-side: every planned message is submitted
 * through `memory.batchCreate` with `onConflict: "replace"` — new ids insert,
 * and an existing row is rewritten in place only when content/meta/temporal
 * differ. The deterministic meta carries `importer_version`, so a parser change
 * (version bump) makes meta differ and re-renders, while an unchanged re-import
 * is a no-op; all outcomes are classified from the batch response. No
 * existing-state pre-fetch, so sessions of any size (including past the
 * 1000-row search page) reconcile exactly. Per session that is ceil(n/chunk)
 * `memory.batchCreate` calls; the live-capture hook adds one `memory.search`
 * to narrow the submission to the new suffix.
 */

import type { MemoryCreateParams } from "@memory.build/protocol/memory";
import { batchCreateChunked } from "../chunk.ts";
import type { MemoryClient } from "../client.ts";
import type { ProgressReporter } from "./progress.ts";
import { boundedUniqueLabel, normalizeSlug, SlugRegistry } from "./slug.ts";
import { stampConversationLinks } from "./thread-links.ts";
import { renderMessageContent, synthesizeTitle } from "./transcript.ts";
import type {
  ConversationMessage,
  ImportedSession,
  ImporterOptions,
  ImporterStats,
} from "./types.ts";
import { uuidv7At } from "./uuid.ts";

/**
 * Version tag stored in `meta.importer_version`. Bumping this forces a
 * re-render of every previously-imported message on the next run: the new
 * value changes meta, so the server's content-aware `onConflict: "replace"`
 * rewrites every previously-imported row, propagating parser changes without
 * manual intervention.
 *
 * Locked at "1" during pre-release iteration — bump only after the first
 * real release so early adopters get parser fixes without a manual wipe.
 */
export const IMPORTER_VERSION = "1";

/** Meta key carrying the importer version (provenance; a bump re-renders via the meta diff). */
const IMPORTER_VERSION_KEY = "importer_version";

/** Max length of one ltree label (well under Postgres' per-label limit). */
const SESSION_LABEL_MAX = 200;
/** Memory-name length cap (DB CHECK), minus the `msg_` prefix below. */
const MESSAGE_NAME_BODY_MAX = 128 - "msg_".length;

/**
 * The ltree node for one session:
 * `<root>.<slug>.<sessionsNode>.<sessionLabel>` — or, when a `.me` project tree
 * is in effect, `<tree>.<sessionsNode>.<sessionLabel>` (no slug).
 * The session id is mapped to a valid, collision-free ltree label via
 * `boundedUniqueLabel` — `normalizeSlug` alone is lossy (e.g. it merges a UUID's
 * dashes), so distinct session ids could otherwise share one node. Each session
 * is its own node so its messages are browsable as named leaves under it.
 */
function sessionTree(
  options: WriteOptions,
  slug: string,
  sessionId: string,
): string {
  const label = boundedUniqueLabel(sessionId, normalizeSlug, SESSION_LABEL_MAX);
  // A `.me` project tree is the full project node — nest sessions directly under
  // it (no slug). Otherwise the slug is the per-project node under `treeRoot`.
  const projectNode = options.tree ?? `${options.treeRoot}.${slug}`;
  return `${projectNode}.${options.sessionsNodeName}.${label}`;
}

/**
 * A message's leaf name within its session node: `msg_<messageId>`, mapped to
 * the name charset and capped at 128 chars. `boundedUniqueLabel` appends a hash
 * of the full id when the mapping is lossy or over-length, so distinct ids
 * (`a/b`, `a:b`, `a_b`) don't collapse to one slot. `(tree, name)` is the
 * idempotency key, so the same message always lands in the same slot across
 * re-imports.
 */
function messageName(messageId: string): string {
  const body = boundedUniqueLabel(
    messageId,
    (s) => s.replace(/[^A-Za-z0-9._-]/g, "_"),
    MESSAGE_NAME_BODY_MAX,
  );
  return `msg_${body}`;
}

/**
 * The SHARED projects parent (`share.projects`). No longer any command's
 * default — captures and session/git imports default to the private
 * {@link DEFAULT_PRIVATE_TREE_ROOT} instead. Kept for explicit opt-ins: a
 * project whose `.me/config.yaml` pins a `/share/projects/<slug>` tree, or an
 * explicit `--tree-root share.projects` on the import commands.
 */
export const DEFAULT_TREE_ROOT = "share.projects";
/**
 * Default capture layout, shared by `me import <tool>`, `me import git`, and
 * the capture hooks so live + imported sessions land in the same place:
 * `<DEFAULT_PRIVATE_TREE_ROOT>.<project_slug>.<DEFAULT_SESSIONS_NODE_NAME>`.
 * PRIVATE by default — `~` is the caller's home (`home.<id>`, expanded
 * server-side by `normalizeTreePath`), so captures are visible only to the
 * capturing user unless a project's `.me/config.yaml` explicitly points at a
 * shared tree.
 */
export const DEFAULT_PRIVATE_TREE_ROOT = "~/projects";
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
  /**
   * The PARENT tree for the multi-project consumers — the bulk `me import
   * <tool>` sweep (walks many projects) and a global/headless plugin pin. The
   * per-project slug is appended: `<treeRoot>.<slug>.<sessionsNodeName>`. It is
   * NOT redundant with `tree` (below): this one nests many projects by
   * slug; `tree` is a single project's full node. Lenient wire form
   * (`~`/`/` accepted, `~` only as the first segment); normalized server-side.
   * Default: the private `~/projects` ({@link DEFAULT_PRIVATE_TREE_ROOT}).
   */
  treeRoot: string;
  /**
   * A single project's full TREE (e.g. from a `.me/config.yaml` `tree`). When
   * set it is used verbatim as the project node and the per-project slug is
   * NOT appended — sessions nest as `<tree>.<sessionsNodeName>.<label>` rather
   * than `<treeRoot>.<slug>.<sessionsNodeName>.<label>`. Lenient wire form
   * (`~`/`/` accepted); normalized server-side. Wins over `treeRoot` when
   * present.
   */
  tree?: string;
  /** Per-project node name for imported agent sessions. */
  sessionsNodeName: string;
  /** Include full transcript (reasoning/tool calls) in message memories. */
  fullTranscript: boolean;
  /** Don't write anything — just report what would happen. */
  dryRun: boolean;
  /** Verbose per-session logging. */
  verbose: boolean;
}

/**
 * Where one session's writes go — resolved per PROJECT by the caller
 * (`createSessionRouter` in commands/import.ts), so a bulk sweep mirrors the
 * live hook: each session lands on its project's server + space, under its
 * project's tree.
 */
export interface SessionRoute {
  /** Client bound to the session project's server + space. */
  engine: MemoryClient;
  /** The project's full tree (no slug appended) when its `.me` pins one. */
  tree?: string;
  /** Parent for the per-slug fallback layout (`<treeRoot>.<slug>.…`). */
  treeRoot: string;
}

/**
 * Per-session routing decision: a route to write through, or a skip — the
 * session is tallied under `discovery.skipped[reason]` and not written (e.g.
 * its project pins an untrusted server, or the caller holds no credentials
 * for that server). `detail` carries the underlying error message for
 * verbose output.
 */
export type SessionRouteDecision =
  | { route: SessionRoute }
  | { skip: string; detail?: string };

/** Resolves a session's cwd to its routing decision (memoized by the caller). */
export type SessionRouter = (
  cwd: string | undefined,
) => SessionRouteDecision | Promise<SessionRouteDecision>;

/**
 * Run discovery + writes for a single importer. With a `router`, each
 * session's engine/tree/treeRoot come from its own project's config
 * (`writeOptions.tree`/`treeRoot` are superseded per session); without one,
 * every session writes through `engine` under `writeOptions`.
 */
export async function runImport(
  engine: MemoryClient,
  importer: Importer,
  importerOptions: ImporterOptions,
  writeOptions: WriteOptions,
  progress?: ProgressReporter,
  router?: SessionRouter,
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

    // Route the session to its project's client + tree. A skip (untrusted
    // `.me` server, no credentials for that server, …) is tallied like a
    // discovery skip and the session is not written.
    let sessionEngine = engine;
    let write = writeOptions;
    if (router) {
      const decision = await router(session.cwd);
      if ("skip" in decision) {
        stats.skipped[decision.skip] = (stats.skipped[decision.skip] ?? 0) + 1;
        if (writeOptions.verbose) {
          const detail = decision.detail ? ` — ${decision.detail}` : "";
          progress?.log(`  skipped (${decision.skip}): ${title}${detail}`);
        }
        continue;
      }
      sessionEngine = decision.route.engine;
      write = {
        ...writeOptions,
        tree: decision.route.tree,
        treeRoot: decision.route.treeRoot,
      };
    }
    sessionsProcessed++;

    const { slug, gitRoot, gitRemote } = await slugs.resolve(session.cwd);
    const tree = sessionTree(write, slug, session.sessionId);

    const outcome = await writeSession(
      sessionEngine,
      session,
      title,
      tree,
      slug,
      gitRoot,
      gitRemote,
      write,
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
  const tree = sessionTree(options, slug, session.sessionId);

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
 * failures, and collapses events sharing a (tree, name) (resume/replay
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
    const meta = buildMeta(
      session,
      message,
      projectSlug,
      gitRoot,
      gitRemote,
      options,
    );
    const temporal = { start: new Date(timestampMs).toISOString() };
    const name = messageName(message.messageId);
    const id = uuidv7At(timestampMs);
    planned.push({
      message,
      memoryId: id,
      payload: { id, name, content, meta, tree, temporal },
    });
  }

  // Dedup on (tree, name) — the idempotency key — so resume/replay artefacts
  // (the same messageId twice in one file) collapse before submit. tree is
  // constant within a session, so the name alone distinguishes them.
  const dedup = dedupBy(planned, (p) => p.payload.name ?? "");
  // Stamp thread links ($prev/$thread) over the final surviving order — before
  // any incremental suffix-narrowing, so a submitted suffix still points back at
  // its predecessor's stable path.
  stampConversationLinks(
    dedup.unique.map((p) => p.payload),
    session.sessionId,
  );
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
 * Submit planned messages through `onConflict: "replace"` and fold the outcome
 * into `outcome`: new ids insert, rows whose content/meta/temporal differ are
 * rewritten in place (a version bump changes meta → the re-render), and
 * unchanged rows are skipped — all classified from the batch response,
 * independent of how many messages the session already has server-side.
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

  const { results, errors } = await batchCreateChunked(
    engine,
    planned.map((p) => p.payload),
    { onConflict: "replace" },
  );
  // Per-row status: inserted (new), updated (re-rendered), skipped (unchanged —
  // a content-aware replace no-op). 'error' rows are tallied via errors[] below.
  for (const r of results) {
    if (r.status === "inserted") outcome.inserted += 1;
    else if (r.status === "updated") outcome.updated += 1;
    else if (r.status === "skipped") outcome.skipped += 1;
  }
  for (const e of errors) {
    outcome.failed += e.itemCount;
    for (const id of e.ids) {
      outcome.errors.push({ messageId: id, error: e.error });
    }
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
    // No per-run timestamp here: meta must be deterministic so a re-import is a
    // content-aware-replace no-op (the row's created_at/updated_at carry timing).
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
 * Drop items whose `key` has already been seen, preserving order. Callers key
 * on the idempotency slot: the transcript planner passes the `(tree, name)`
 * key, the git importer the commit sha — so resume/replay artefacts (the same
 * record twice in one batch) collapse before submit and don't trip the unique
 * constraint server-side. Exported so the dedup behavior can be unit-tested
 * without standing up a fake MemoryClient.
 */
export function dedupBy<T>(
  items: T[],
  key: (item: T) => string,
): { unique: T[]; duplicates: number } {
  const seen = new Set<string>();
  const unique: T[] = [];
  let duplicates = 0;
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) {
      duplicates++;
      continue;
    }
    seen.add(k);
    unique.push(item);
  }
  return { unique, duplicates };
}

export type { ProgressReporter } from "./progress.ts";
export { createProgressReporter } from "./progress.ts";
export { SlugRegistry } from "./slug.ts";
export { synthesizeTitle } from "./transcript.ts";
export { uuidv7At } from "./uuid.ts";
