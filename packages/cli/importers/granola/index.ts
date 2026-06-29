/**
 * Granola meeting importer.
 *
 * Reads Granola's locally-stored session (see `auth.ts`), refreshes the access
 * token, and pulls every meeting from the Granola API (`client.ts`). Each
 * meeting becomes one memory under `<tree-root>.<id>`, named by the meeting's
 * Granola document id so `(tree, name)` is the idempotency key — re-imports
 * collapse onto the same row. The id is a timestamp-prefixed UUIDv7 so memories
 * sort by meeting time.
 *
 * Reconciliation is server-side: every meeting is submitted through
 * `memory.batchCreate` with `onConflict: "replace"`. The deterministic meta
 * carries `importer_version`, so a render change (version bump) re-renders in
 * place while an unchanged re-import is a no-op. Notes-only meetings are cheap
 * (one list call); transcripts and panels are fetched per meeting only when
 * needed, so `--no-transcript` imports skip those round-trips entirely.
 */

import type { MemoryCreateParams } from "@memory.build/protocol/memory";
import { batchCreateChunked } from "../../chunk.ts";
import type { MemoryClient } from "../../client.ts";
import { IMPORTER_VERSION } from "../index.ts";
import type { ProgressReporter } from "../progress.ts";
import { boundedUniqueLabel } from "../slug.ts";
import { uuidv7At } from "../uuid.ts";
import {
  GranolaClient,
  type GranolaDocument,
  type GranolaPanel,
  type GranolaTranscriptSegment,
} from "./client.ts";
import { type GranolaMeeting, meetingStart, renderMeeting } from "./render.ts";

/** Default tree root for imported meetings. Under the caller's home. */
export const DEFAULT_GRANOLA_TREE_ROOT = "~.granola";
/** Memory-name length cap (DB CHECK) for the meeting leaf. */
const MEETING_NAME_MAX = 128;

/** Options that affect what the importer pulls and writes. */
export interface GranolaImportOptions {
  /** Override the Granola application-support directory. */
  granolaDir?: string;
  /** Refresh token (already read from local storage by the caller). */
  refreshToken: string;
  /** Tree root under which `<document_id>` leaves are placed. */
  treeRoot: string;
  /** Only import meetings started at or after this ISO timestamp. */
  since?: string;
  /** Only import meetings started at or before this ISO timestamp. */
  until?: string;
  /** Skip meetings Granola flagged `valid_meeting: false`. Default true. */
  skipInvalid: boolean;
  /** Include the full transcript in each memory (extra API calls). */
  includeTranscript: boolean;
  /** Don't write — just report what would happen. */
  dryRun: boolean;
}

/** Per-reason skip counts for the run. */
export type GranolaSkipReason =
  | "deleted"
  | "invalid_meeting"
  | "since_filter"
  | "until_filter"
  | "empty";

/** Structured result of one Granola import run. */
export interface GranolaImportResult {
  tree: string;
  dryRun: boolean;
  includeTranscript: boolean;
  meetingsSeen: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  skipReasons: Record<string, number>;
  errors: Array<{ documentId: string; error: string }>;
}

/** The meeting leaf name within the tree root: the Granola document id. */
function meetingName(documentId: string): string {
  return boundedUniqueLabel(
    documentId,
    (s) => s.replace(/[^A-Za-z0-9._-]/g, "_"),
    MEETING_NAME_MAX,
  );
}

/** Decide whether a document is skipped before any per-meeting fetches. */
function preFilter(
  doc: GranolaDocument,
  options: GranolaImportOptions,
): GranolaSkipReason | null {
  if (doc.deleted_at) return "deleted";
  if (options.skipInvalid && doc.valid_meeting === false) {
    return "invalid_meeting";
  }
  const start = meetingStart(doc);
  if (start) {
    const ms = Date.parse(start);
    if (options.since) {
      const s = Date.parse(options.since);
      if (!Number.isNaN(s) && ms < s) return "since_filter";
    }
    if (options.until) {
      const u = Date.parse(options.until);
      if (!Number.isNaN(u) && ms > u) return "until_filter";
    }
  }
  return null;
}

/**
 * Build a meeting's memory payload, fetching panels (notes) and, when
 * requested, the transcript. Returns null when the meeting renders to nothing
 * worth storing (no notes and no transcript and no title).
 */
async function buildMeetingMemory(
  client: GranolaSource,
  doc: GranolaDocument,
  options: GranolaImportOptions,
): Promise<MemoryCreateParams | null> {
  // Notes may already be on the document; otherwise panels carry the AI summary.
  const needPanels = !doc.notes_markdown?.trim();
  const panels = needPanels ? await client.getPanels(doc.id) : [];
  const transcript = options.includeTranscript
    ? await client.getTranscript(doc.id)
    : [];

  const meeting: GranolaMeeting = { document: doc, panels, transcript };
  const rendered = renderMeeting(meeting, {
    includeTranscript: options.includeTranscript,
  });

  // A meeting with no notes and no transcript is just a calendar stub — skip it
  // unless the user explicitly wants transcripts (where an empty one is still a
  // deliberate capture). We treat "has a title + a date" as enough signal only
  // when there's also notes or transcript content.
  if (!rendered.meta.has_notes && !rendered.meta.has_transcript) {
    return null;
  }

  const startMs = rendered.startedAt
    ? Date.parse(rendered.startedAt)
    : Date.now();
  const temporal = rendered.startedAt
    ? rendered.endedAt
      ? { start: rendered.startedAt, end: rendered.endedAt }
      : { start: rendered.startedAt }
    : undefined;

  return {
    id: uuidv7At(startMs),
    name: meetingName(doc.id),
    content: rendered.content,
    meta: { ...rendered.meta, importer_version: IMPORTER_VERSION },
    tree: options.treeRoot,
    ...(temporal ? { temporal } : {}),
  };
}

/** The slice of GranolaClient the importer consumes (injectable for tests). */
export interface GranolaSource {
  listDocuments(pageSize?: number): AsyncIterable<GranolaDocument>;
  getPanels(documentId: string): Promise<GranolaPanel[]>;
  getTranscript(documentId: string): Promise<GranolaTranscriptSegment[]>;
}

/**
 * Run a full Granola import: list meetings, render each, and submit through the
 * server's conditional upsert. Progress (when provided) ticks per meeting.
 *
 * `source` is injectable for tests; in production the caller omits it and we
 * build a real `GranolaClient` from the refresh token.
 */
export async function runGranolaImport(
  engine: MemoryClient,
  options: GranolaImportOptions,
  progress?: ProgressReporter,
  source?: GranolaSource,
): Promise<GranolaImportResult> {
  const client = source ?? (await GranolaClient.create(options.refreshToken));

  const skipReasons: Record<string, number> = {};
  const errors: Array<{ documentId: string; error: string }> = [];
  const planned: MemoryCreateParams[] = [];
  let meetingsSeen = 0;

  for await (const doc of client.listDocuments()) {
    meetingsSeen++;
    progress?.process(doc.title?.trim() || doc.id);

    const skip = preFilter(doc, options);
    if (skip) {
      skipReasons[skip] = (skipReasons[skip] ?? 0) + 1;
      continue;
    }

    try {
      const payload = await buildMeetingMemory(client, doc, options);
      if (!payload) {
        skipReasons.empty = (skipReasons.empty ?? 0) + 1;
        continue;
      }
      planned.push(payload);
    } catch (error) {
      errors.push({
        documentId: doc.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let failed = errors.length;

  if (options.dryRun) {
    inserted = planned.length;
  } else if (planned.length > 0) {
    const { results, errors: chunkErrors } = await batchCreateChunked(
      engine,
      planned,
      { onConflict: "replace" },
    );
    for (const r of results) {
      if (r.status === "inserted") inserted++;
      else if (r.status === "updated") updated++;
      else if (r.status === "skipped") skipped++;
    }
    for (const e of chunkErrors) {
      failed += e.itemCount;
      for (const id of e.ids) errors.push({ documentId: id, error: e.error });
    }
  }

  return {
    tree: options.treeRoot,
    dryRun: options.dryRun,
    includeTranscript: options.includeTranscript,
    meetingsSeen,
    inserted,
    updated,
    skipped,
    failed,
    skipReasons,
    errors,
  };
}
