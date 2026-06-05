/**
 * User-facing tree-path normalization.
 *
 * Memories live under an ltree `tree` path (dot-separated; the root is the empty
 * path). At the user-facing boundary (RPC handlers, CLI, MCP) we accept lenient
 * input and normalize it once to the canonical ltree form. The store layer and
 * SQL functions stay ltree-native and only ever see canonical paths.
 *
 * Conventions:
 *   - **Separators**: `/` and `.` are interchangeable; runs collapse; leading and
 *     trailing separators are dropped. `/a/b`, `a/b`, `a.b` → `a.b`.
 *   - **Root**: ``, `/`, `.` → `` (the empty ltree path).
 *   - **Home**: a leading `~` segment expands to `home.<member>`, where
 *     `<member>` is the caller's principal id with hyphens stripped (a valid
 *     ltree label). `~` → `home.<member>`, `~/bar` → `home.<member>.bar`.
 *     `~` is only meaningful as the first segment.
 *   - **Labels** (concrete paths): each segment must be a legal ltree label
 *     (`[A-Za-z0-9_-]+`, PG16+); anything else throws `TreePathError`.
 *
 * Two entry points:
 *   - `normalizeTreePath` — a concrete path (create/update/move/grant/…). Strict
 *     label validation.
 *   - `normalizeTreeFilter` — a search filter, which may be an ltree `lquery`
 *     (`*.api.*`) or `ltxtquery`. Expands `~` and slashes but does NOT validate
 *     labels, so wildcard/query syntax passes through untouched.
 */

/** The reserved top-level namespace for per-principal home directories. */
export const HOME_NAMESPACE = "home";

/** A legal ltree label (PostgreSQL 16+): letters, digits, underscore, hyphen. */
const LTREE_LABEL = /^[A-Za-z0-9_-]+$/;

/** Thrown on malformed user input (mapped to a validation error at the boundary). */
export class TreePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreePathError";
  }
}

export interface TreePathOptions {
  /**
   * The principal id whose home a leading `~` expands to. Required to use `~`;
   * omitting it makes a `~` segment an error.
   */
  home?: string;
}

/** The canonical ltree prefix for a principal's home: `home.<id-without-hyphens>`. */
export function homePrefix(principalId: string): string {
  const id = principalId.replace(/-/g, "");
  if (!LTREE_LABEL.test(id)) {
    throw new TreePathError(
      `invalid home principal id: ${JSON.stringify(principalId)}`,
    );
  }
  return `${HOME_NAMESPACE}.${id}`;
}

/** Split on runs of `/` or `.`, dropping empty segments. */
function splitSegments(input: string): string[] {
  return input.split(/[/.]+/).filter((s) => s.length > 0);
}

/**
 * Normalize a concrete tree path to canonical ltree. Lenient on separators and
 * a leading `~`; strict on labels. Returns `""` for the root.
 */
export function normalizeTreePath(
  input: string,
  opts: TreePathOptions = {},
): string {
  const segments = splitSegments(input);
  if (segments.length === 0) return "";

  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as string;
    if (seg === "~") {
      if (i !== 0) {
        throw new TreePathError("'~' is only valid as the first path segment");
      }
      if (opts.home === undefined) {
        throw new TreePathError("'~' (home) is not available here");
      }
      out.push(homePrefix(opts.home)); // already a valid `home.<id>` ltree
      continue;
    }
    if (!LTREE_LABEL.test(seg)) {
      throw new TreePathError(
        `invalid tree path segment: ${JSON.stringify(seg)}`,
      );
    }
    out.push(seg);
  }
  return out.join(".");
}

/**
 * Normalize a search filter (lquery / ltxtquery): expand a leading `~`, treat
 * `/` as a separator, collapse and trim separators — but pass wildcard/query
 * syntax through unvalidated. Returns `""` when there is no filter.
 */
export function normalizeTreeFilter(
  input: string,
  opts: TreePathOptions = {},
): string {
  let s = input.trim();
  if (s === "") return "";

  // Leading `~` home expansion (only as the first segment).
  if (s === "~" || s.startsWith("~/") || s.startsWith("~.")) {
    if (opts.home === undefined) {
      throw new TreePathError("'~' (home) is not available here");
    }
    s = homePrefix(opts.home) + s.slice(1); // "~/foo" → "home.<id>/foo"
  }

  // Slash → dot, collapse separator runs, trim ends.
  s = s
    .replace(/\//g, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "");
  return s;
}

/**
 * Reverse of the home expansion, for display. A path under the given
 * principal's home is shown with a leading `~` and slash separators
 * (`home.<id>` → `~`, `home.<id>.a.b` → `~/a/b`); everything else (including
 * other principals' homes) is returned unchanged.
 */
export function denormalizeTreePath(
  path: string,
  opts: TreePathOptions = {},
): string {
  if (opts.home === undefined) return path;
  const prefix = homePrefix(opts.home);
  if (path === prefix) return "~";
  if (path.startsWith(`${prefix}.`)) {
    const rest = path.slice(prefix.length + 1);
    return `~/${rest.split(".").join("/")}`;
  }
  return path;
}
