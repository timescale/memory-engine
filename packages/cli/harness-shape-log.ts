/**
 * Best-effort logging of unrecognized harness hook payload shapes
 * (HARNESS_DESIGN.md, PR 2 intro): the Codex/Gemini rewrite hooks are
 * fail-open on anything they don't understand — an internal error or a
 * payload that doesn't match the vendored shape. A silent fail-open would
 * otherwise surface, much later, as an unexplained failsafe error ("why is
 * `me` refusing to run as me?") with no trail back to "Codex/Gemini shipped a
 * payload update". So every unrecognized-shape fail-open also appends one
 * line here — STRUCTURE only (top-level keys, sorted; never values, since a
 * command string can carry secrets) — for `me doctor` (a later PR) to
 * summarize as "N unrecognized payload shapes since <date>: upgrade `me` or
 * file an issue."
 *
 * Logging failures (permission errors, a full disk) are swallowed — this is
 * diagnostics for an already-degraded path, never allowed to make it worse.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Config directory — respects $XDG_CONFIG_HOME, defaults to ~/.config/me. Mirrors credentials.ts's private getConfigDir(). */
function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg || join(homedir(), ".config");
  return join(base, "me");
}

/** NDJSON log of unrecognized harness hook payload shapes. */
export function getShapeLogPath(): string {
  return join(getConfigDir(), "state", "harness-payload-shapes.ndjson");
}

/** One logged entry: when, which harness, and the payload's shape (never its values). */
export interface ShapeLogEntry {
  ts: string;
  harness: string;
  /** Sorted top-level keys of the payload, or a type marker when it wasn't a plain object. */
  shape: string[] | string;
}

/** Cap the log file at this many most-recent entries (a rotating diagnostic
 * trail, not an audit log — unbounded growth from a persistent harness
 * update would otherwise never stop). */
const MAX_ENTRIES = 200;

/** Describe a payload's shape: sorted top-level keys, or a type marker. */
function describeShape(payload: unknown): string[] | string {
  if (payload === null) return "null";
  if (Array.isArray(payload)) return "array";
  if (typeof payload !== "object") return typeof payload;
  return Object.keys(payload as Record<string, unknown>).sort();
}

/**
 * Append one shape-log entry for `harness`, describing `payload`'s shape.
 * Best-effort: any filesystem error is swallowed.
 */
export function logUnrecognizedPayloadShape(
  harness: string,
  payload: unknown,
): void {
  try {
    const path = getShapeLogPath();
    const entry: ShapeLogEntry = {
      ts: new Date().toISOString(),
      harness,
      shape: describeShape(payload),
    };

    let lines: string[] = [];
    if (existsSync(path)) {
      lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    }
    lines.push(JSON.stringify(entry));
    if (lines.length > MAX_ENTRIES) lines = lines.slice(-MAX_ENTRIES);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${lines.join("\n")}\n`);
  } catch {
    // Diagnostics for an already-degraded path — never let this throw.
  }
}

/** Read all logged entries, oldest first. Empty array if the log is absent
 * or corrupt (a line that doesn't parse is skipped, not fatal). Used by a
 * later `me doctor`. */
export function readShapeLog(): ShapeLogEntry[] {
  const path = getShapeLogPath();
  if (!existsSync(path)) return [];
  const entries: ShapeLogEntry[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as ShapeLogEntry);
    } catch {
      // Skip a corrupt line rather than failing the whole read.
    }
  }
  return entries;
}
