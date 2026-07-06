/**
 * Shared helpers for filesystem-derived markdown imports (`me import slab`,
 * `me import docs`): the arithmetic that maps a directory layout of markdown
 * files onto Memory Engine `(tree, name)` slots.
 *
 * All pure and deterministic — these outputs are idempotency keys, so both
 * importers must agree on them across runs. Importer-specific policy (which
 * files to walk, what goes in meta, temporal/id derivation) stays with each
 * importer.
 */

import { normalizeSlug } from "./slug.ts";

/** Memory-name length cap (mirrors the DB CHECK / memoryNameSchema). */
export const MAX_NAME_LEN = 128;

/**
 * Normalize a directory segment to a valid ltree label. Delegates to the
 * shared `normalizeSlug` (lowercase, non-alphanumeric runs -> `_`,
 * collapse/trim, a purely-numeric label gets a `p_` prefix) so
 * filesystem-derived tree labels follow the same rule as the agent-session
 * importers.
 */
export function normalizeTreeLabel(raw: string): string {
  return normalizeSlug(raw);
}

/**
 * Normalize an extension-less filename base to the memory-name charset, so
 * that base plus a later extension matches `memoryNameSchema`
 * (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, <= 128 chars).
 *
 * Lowercase, keep `[a-z0-9._-]`, replace other runs with `-`, strip leading
 * non-alphanumerics and trailing punctuation, collapse repeats, and truncate
 * to `maxLen` (callers leave room for their extension). Uniqueness within a
 * tree is enforced separately (see makeUniqueName).
 */
export function normalizeNameBase(
  base: string,
  maxLen: number = MAX_NAME_LEN,
): string {
  let s = base.toLowerCase();
  s = s.replace(/[^a-z0-9._-]+/g, "-"); // illegal runs -> single dash
  s = s.replace(/-+/g, "-"); // collapse dashes
  s = s.replace(/^[^a-z0-9]+/, ""); // must start alphanumeric
  s = s.replace(/[-._]+$/, ""); // tidy trailing punctuation
  if (s.length > maxLen) {
    s = s.slice(0, maxLen).replace(/[-._]+$/, "");
  }
  return s.length > 0 ? s : "untitled";
}

/**
 * Ensure a name is unique within its tree, appending `-2`, `-3`, ... on clash.
 * Deterministic given a stable (sorted) walk order, so re-imports keep the same
 * `(tree, name)` slots. `used` maps a tree to the names already taken in it.
 * `maxLen` caps the result (default the full name cap; callers pass a smaller
 * cap so a later extension still fits).
 */
export function makeUniqueName(
  tree: string,
  name: string,
  used: Map<string, Set<string>>,
  maxLen: number = MAX_NAME_LEN,
): string {
  let seen = used.get(tree);
  if (!seen) {
    seen = new Set<string>();
    used.set(tree, seen);
  }
  if (!seen.has(name)) {
    seen.add(name);
    return name;
  }
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const head = name.slice(0, maxLen - suffix.length).replace(/[-._]+$/, "");
    const candidate = `${head}${suffix}`;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      return candidate;
    }
  }
}

/** First `# H1` heading, else the given fallback (emoji/case intact). */
export function extractMarkdownTitle(
  content: string,
  fallback: string,
): string {
  const m = content.match(/^#\s+(.+)$/m);
  if (m?.[1]) return m[1].trim();
  return fallback;
}

/**
 * Build `<treeRoot>.<labels>` from a directory path relative to the import
 * root ("" or "." is the root itself). Each segment is slugified to an ltree
 * label; both `/` and `\` separate segments.
 */
export function treeForRelativeDir(treeRoot: string, relDir: string): string {
  if (relDir === "" || relDir === ".") return treeRoot;
  const labels = relDir
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(normalizeTreeLabel);
  return [treeRoot, ...labels].join(".");
}
