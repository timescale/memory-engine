/**
 * Shared JSON hooks-file upsert for Codex (`~/.codex/hooks.json`) and Gemini
 * CLI (`~/.gemini/settings.json`) — both use the same
 * `{ hooks: { <EventName>: [ { matcher, hooks: [{ type, command, ... }] } ] } }`
 * shape (Codex's top-level file IS the hooks config; Gemini's hooks live
 * under a `hooks` key alongside the rest of `settings.json`).
 *
 * Our managed entry is identified by its hook `command` (an exact string,
 * e.g. `"me codex env-hook"`) — never a marker comment (JSON has none) — so
 * a re-install upserts it in place (byte-identical → no-op; a genuine
 * definition change → replaced) while leaving every other, user-authored
 * entry in the array untouched.
 *
 * Codex trusts a hook by the hash of its definition text, so keeping the
 * entry's JSON IDENTICAL across `me` versions matters — callers must pass a
 * fixed, version-free `entry` object.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One hook definition within an event's array (Codex/Gemini's shared shape). */
export interface JsonHookEntry {
  matcher: string;
  hooks: Array<{ type: string; command: string; [key: string]: unknown }>;
  /** Extra event-level fields some harnesses support (e.g. Gemini's `sequential`) — passed through as given. */
  [key: string]: unknown;
}

/**
 * Upsert `entry` into `<path>`'s `hooks[eventKey]` array, matched by
 * `matchCommand` (an existing entry whose `hooks[]` contains that command is
 * replaced in place; otherwise `entry` is appended). Throws on a malformed
 * existing file rather than silently replacing it — this file may hold a
 * user's own hooks. Returns whether the file changed (byte-identical is a
 * no-op, so a re-install doesn't touch the file's mtime).
 */
export function upsertJsonHooksFile(
  path: string,
  eventKey: string,
  entry: JsonHookEntry,
  matchCommand: string,
): { path: string; changed: boolean } {
  let root: Record<string, unknown> = {};
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8"));
    } catch (error) {
      throw new Error(
        `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error(`${path} must contain a JSON object`);
    }
    root = parsed as Record<string, unknown>;
  }

  const hooksRoot: Record<string, unknown> =
    root.hooks !== null &&
    typeof root.hooks === "object" &&
    !Array.isArray(root.hooks)
      ? (root.hooks as Record<string, unknown>)
      : {};
  const existingList = Array.isArray(hooksRoot[eventKey])
    ? (hooksRoot[eventKey] as unknown[])
    : [];
  const list = [...existingList];

  const idx = list.findIndex(
    (e) =>
      e !== null &&
      typeof e === "object" &&
      Array.isArray((e as { hooks?: unknown }).hooks) &&
      (e as { hooks: Array<{ command?: unknown }> }).hooks.some(
        (h) => h?.command === matchCommand,
      ),
  );

  if (idx !== -1 && JSON.stringify(list[idx]) === JSON.stringify(entry)) {
    return { path, changed: false };
  }

  if (idx !== -1) list[idx] = entry;
  else list.push(entry);

  hooksRoot[eventKey] = list;
  root.hooks = hooksRoot;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
  return { path, changed: true };
}
