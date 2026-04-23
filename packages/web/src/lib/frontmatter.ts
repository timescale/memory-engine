/**
 * Parse/serialize YAML frontmatter + Markdown body.
 *
 * Mirrors the Markdown import schema in `docs/formats.md`, scoped to the
 * fields the editor allows the user to change:
 *
 *   - `tree`    — ltree path string
 *   - `meta`    — arbitrary JSON object
 *   - `temporal`— `{ start, end? }` object (same shape the server returns)
 *
 * `id`, `createdAt`, `createdBy`, `updatedAt`, and `hasEmbedding` are
 * read-only and live in the MetadataPanel, not the editor. If the frontmatter
 * contains those keys they are ignored on save.
 */
import yaml from "js-yaml";
import type { Memory, Temporal } from "../api/types.ts";

export interface ParsedFrontmatter {
  /** Editable fields extracted from frontmatter. Missing → null. */
  tree: string;
  meta: Record<string, unknown>;
  temporal: Temporal | null;
  /** Markdown body (everything after the closing `---`). */
  body: string;
}

/**
 * Build the initial editor text for a memory:
 *
 * ```
 * ---
 * tree: work.projects.me
 * meta:
 *   priority: high
 * temporal:
 *   start: 2026-04-01T00:00:00Z
 *   end: 2026-04-30T00:00:00Z
 * ---
 * body…
 * ```
 *
 * Empty fields are omitted entirely so the editor starts clean.
 */
export function memoryToEditorText(memory: Memory): string {
  const frontmatter: Record<string, unknown> = {};
  if (memory.tree) frontmatter.tree = memory.tree;
  if (memory.meta && Object.keys(memory.meta).length > 0) {
    frontmatter.meta = memory.meta;
  }
  if (memory.temporal) frontmatter.temporal = memory.temporal;

  if (Object.keys(frontmatter).length === 0) {
    return memory.content;
  }

  const yamlText = yaml
    .dump(frontmatter, { lineWidth: 0, noRefs: true })
    .trimEnd();
  return `---\n${yamlText}\n---\n\n${memory.content}`;
}

/**
 * Parse editor text back into its parts. Throws if the YAML is invalid or
 * a known key has the wrong shape.
 */
export function parseEditorText(source: string): ParsedFrontmatter {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    // No frontmatter — everything is body.
    return {
      tree: "",
      meta: {},
      temporal: null,
      body: source,
    };
  }

  const [, rawYaml = "", bodyWithLeadingNewline = ""] = match;
  const body = bodyWithLeadingNewline.replace(/^\r?\n/, "");

  let parsed: unknown;
  try {
    parsed = yaml.load(rawYaml);
  } catch (err) {
    throw new Error(
      `Invalid frontmatter YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (parsed === null || parsed === undefined) {
    return { tree: "", meta: {}, temporal: null, body };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Frontmatter must be a YAML mapping");
  }

  const obj = parsed as Record<string, unknown>;
  return {
    tree: coerceTree(obj.tree),
    meta: coerceMeta(obj.meta),
    temporal: coerceTemporal(obj.temporal),
    body,
  };
}

function coerceTree(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new Error("`tree` must be a string");
  }
  return value;
}

function coerceMeta(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("`meta` must be an object");
  }
  return value as Record<string, unknown>;
}

function coerceTemporal(value: unknown): Temporal | null {
  if (value === undefined || value === null) return null;

  // Array form: [start, end?]
  if (Array.isArray(value)) {
    if (value.length === 0 || typeof value[0] !== "string") {
      throw new Error("`temporal` array must start with an ISO timestamp");
    }
    const start = value[0];
    const end = value[1];
    if (end !== undefined && typeof end !== "string") {
      throw new Error("`temporal[1]` must be an ISO timestamp string");
    }
    return { start, end: end ?? start };
  }

  // String form: "start" (same as { start, end: start }).
  if (typeof value === "string") {
    return { start: value, end: value };
  }

  // Object form: { start, end? }
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec.start !== "string") {
      throw new Error("`temporal.start` must be an ISO timestamp string");
    }
    const end = rec.end === undefined || rec.end === null ? rec.start : rec.end;
    if (typeof end !== "string") {
      throw new Error("`temporal.end` must be an ISO timestamp string");
    }
    return { start: rec.start, end };
  }

  throw new Error("`temporal` must be an object, array, or string");
}
