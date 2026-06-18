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
 *   - **Home**: a leading `~` segment expands to the caller's home prefix —
 *     `home.<member>` for a user, or `home.<owner>.<member>` for an agent (whose
 *     home nests under its owner's home; see `homePrefix`). Ids have hyphens
 *     stripped to valid ltree labels. `~` → the prefix, `~/bar` →
 *     `<prefix>.bar`. `~` is only meaningful as the first segment.
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

/**
 * The reserved top-level namespace for a space's shared tree. Unlike `home`,
 * this is a single shared root (not per-principal) and carries no input sugar —
 * `share/x` normalizes like any other path. It exists as a named constant
 * because membership/invitations grant a configurable level (read/write/owner)
 * at this root; see core `redeem_space_invitations`.
 *
 * Canonically defined in `@memory.build/protocol` (the wire contract) and
 * re-exported here so the database/server side keeps a single source of truth.
 */
export { SHARE_NAMESPACE } from "@memory.build/protocol";

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
  /**
   * When set, the home nests under this owner's home: `~` →
   * `home.<homeOwner>.<home>`. Set it for agents (whose home lives under their
   * owner's home so the owner's grant covers it); omit for users.
   */
  homeOwner?: string;
}

/**
 * The canonical ltree prefix for a principal's home (ids hyphen-stripped to
 * valid ltree labels):
 *   - user  (no owner):    `home.<userId>`
 *   - agent (owner given): `home.<ownerId>.<agentId>` — nested under the owner's
 *     home so the owner's `owner@home.<ownerId>` grant covers it and
 *     `agent_tree_access` keeps the agent's home grant (a bare `home.<agentId>`
 *     would be clamped to nothing). Mirrors core `add_principal_to_space`.
 */
export function homePrefix(principalId: string, ownerId?: string): string {
  const self = homeLabel(principalId);
  if (ownerId === undefined) return `${HOME_NAMESPACE}.${self}`;
  return `${HOME_NAMESPACE}.${homeLabel(ownerId)}.${self}`;
}

/** A principal id as a valid ltree label (hyphens stripped). */
function homeLabel(principalId: string): string {
  const id = principalId.replace(/-/g, "");
  if (!LTREE_LABEL.test(id)) {
    throw new TreePathError(
      `invalid home principal id: ${JSON.stringify(principalId)}`,
    );
  }
  return id;
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
      out.push(homePrefix(opts.home, opts.homeOwner)); // valid `home.<…>` ltree
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
    s = homePrefix(opts.home, opts.homeOwner) + s.slice(1); // "~/foo" → "<prefix>/foo"
  }

  // Slash → dot, collapse separator runs, trim ends.
  s = s
    .replace(/\//g, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "");
  return s;
}

/** A bare ltree path: dot-separated `[A-Za-z0-9_-]` labels, no query operators. */
const LTREE_PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/**
 * A classified, normalized search tree filter, tagged by which ltree
 * pattern type it is so the caller can bind it to the matching SQL parameter
 * (`ltree` → `@>` containment, `lquery` → `~`, `ltxtquery` → `@`).
 */
export type TreeFilter =
  | { kind: "ltree"; value: string }
  | { kind: "lquery"; value: string }
  | { kind: "ltxtquery"; value: string };

/**
 * Normalize a search tree filter (via `normalizeTreeFilter`) and classify it as
 * an exact ltree path, an `lquery` pattern, or an `ltxtquery` label search.
 * `normalizeTreeFilter` only expands `~`/slashes — it does not pick a type — so
 * without this the caller can't know which SQL parameter to bind, and casting a
 * wildcard like `foo.*` to `::ltree` throws. Returns `null` for empty input (no
 * filter).
 *
 * Classification (the input has already had `~`/slashes normalized):
 *   - bare ltree path (only `[A-Za-z0-9_-]` labels + `.`) → `ltree` (containment)
 *   - contains `&` (ltxtquery's boolean AND — never valid in lquery) → `ltxtquery`
 *   - anything else (wildcards `*`, `|`, `!`, `{n}`, …)     → `lquery`
 */
export function classifyTreeFilter(
  input: string,
  opts: TreePathOptions = {},
): TreeFilter | null {
  const s = normalizeTreeFilter(input, opts);
  if (s === "") return null;
  if (LTREE_PATH.test(s)) return { kind: "ltree", value: s };
  if (s.includes("&")) return { kind: "ltxtquery", value: s };
  return { kind: "lquery", value: s };
}

/**
 * Reverse of the home expansion, for display, in canonical **slash** form. The
 * caller's home is shown with a leading `~` (`home.<id>` → `~`,
 * `home.<id>.a.b` → `~/a/b`); every other path is rendered as an absolute,
 * slash-separated path with a leading `/` (`share.auth` → `/share/auth`), and
 * the root (empty path) is `/`. So `~` anchors home and `/` anchors the root,
 * shell-style. ltree storage and the SQL layer stay dot-native, and
 * `normalizeTreePath` strips a leading separator and accepts both `/` and `.`,
 * so a displayed path fed back in round-trips.
 */
export function denormalizeTreePath(
  path: string,
  opts: TreePathOptions = {},
): string {
  if (opts.home !== undefined) {
    const prefix = homePrefix(opts.home, opts.homeOwner);
    if (path === prefix) return "~";
    if (path.startsWith(`${prefix}.`)) {
      // home.<id>.a.b → ~/a/b — `~` is the anchor, so no leading slash
      return `~${path.slice(prefix.length).replace(/\./g, "/")}`;
    }
  }
  // Absolute path: leading `/`, dots → slashes. Root ("") → "/".
  return `/${path.replace(/\./g, "/")}`;
}
