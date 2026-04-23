/**
 * Shared filter helpers used by all agent conversation importers.
 *
 * These implement the default-off noise filters ("skip trivial sessions",
 * "skip sessions in temp cwds", etc.) in one place so each importer can
 * call into them consistently.
 *
 * There is intentionally no "skip recently-active sessions" filter:
 * importers are idempotent, keyed by a deterministic UUID per session,
 * and re-running updates in place via `last_message_id` change detection.
 * If an in-flight session gets imported mid-conversation, the next run
 * simply updates the memory — no need to delay the first write.
 */
import type { ImporterOptions, ImporterStats, SkipReason } from "./types.ts";

/**
 * Minimum user turns for a session to count as non-trivial. Sessions
 * with a single user prompt (or none) are typically one-shot queries,
 * warm-up pings, or aborted runs — we want real back-and-forth to
 * justify keeping the memory.
 */
export const TRIVIAL_USER_TURN_THRESHOLD = 2;

/**
 * Record a skip in the importer stats.
 */
export function recordSkip(stats: ImporterStats, reason: SkipReason): void {
  stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
}

/**
 * Is this cwd under a well-known system temp directory?
 */
export function isTempCwd(cwd: string | undefined): boolean {
  if (!cwd) return false;
  return (
    cwd.startsWith("/tmp/") ||
    cwd === "/tmp" ||
    cwd.startsWith("/private/tmp/") ||
    cwd === "/private/tmp" ||
    cwd.startsWith("/private/var/folders/") ||
    cwd.startsWith("/var/folders/")
  );
}

/**
 * Does `cwd` satisfy the optional --project filter?
 *
 * A cwd matches when it equals the filter path or is a descendant of it.
 * Empty/missing filter always matches.
 */
export function matchesProjectFilter(
  cwd: string | undefined,
  filter: string | undefined,
): boolean {
  if (!filter) return true;
  if (!cwd) return false;
  const normalized = filter.replace(/\/+$/, "");
  return cwd === normalized || cwd.startsWith(`${normalized}/`);
}

/**
 * Does `startedAt` fall within the optional --since/--until window?
 * Missing bounds mean unbounded.
 */
export function matchesTimeWindow(
  startedAt: string,
  since: string | undefined,
  until: string | undefined,
): { ok: true } | { ok: false; reason: "since_filter" | "until_filter" } {
  const ms = Date.parse(startedAt);
  if (Number.isNaN(ms)) return { ok: true };
  if (since) {
    const sinceMs = Date.parse(since);
    if (!Number.isNaN(sinceMs) && ms < sinceMs) {
      return { ok: false, reason: "since_filter" };
    }
  }
  if (until) {
    const untilMs = Date.parse(until);
    if (!Number.isNaN(untilMs) && ms > untilMs) {
      return { ok: false, reason: "until_filter" };
    }
  }
  return { ok: true };
}

/**
 * Should this session be skipped based on the global importer options?
 *
 * Returns the skip reason, or null to keep the session. Caller is responsible
 * for calling `recordSkip` with the returned reason.
 */
export function filterBySessionShape(
  session: {
    startedAt: string;
    messageCounts: { user: number; assistant: number };
    cwd?: string;
    isSidechain?: boolean;
  },
  options: ImporterOptions,
): SkipReason | null {
  if (session.isSidechain && !options.includeSidechains) {
    return "sidechain";
  }
  if (isTempCwd(session.cwd) && !options.includeTempCwd) {
    return "temp_cwd";
  }
  if (
    !options.includeTrivial &&
    session.messageCounts.user < TRIVIAL_USER_TURN_THRESHOLD
  ) {
    return "trivial";
  }
  if (!matchesProjectFilter(session.cwd, options.projectFilter)) {
    return "project_filter";
  }
  const window = matchesTimeWindow(
    session.startedAt,
    options.since,
    options.until,
  );
  if (!window.ok) return window.reason;
  return null;
}
