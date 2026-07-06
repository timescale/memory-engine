/**
 * Frontmatter block splitting, shared by markdown-shaped inputs.
 *
 * Two consumers with deliberately different strictness:
 * - `parsers/markdown.ts` (`me import memories`): frontmatter IS the memory
 *   record, so a bad YAML block is a hard per-file error.
 * - `importers/docs.ts` (`me import docs`): frontmatter is the document's own
 *   metadata, so a bad block must never fail the file (it stays verbatim in
 *   the content instead).
 *
 * This module owns only the block *splitting*, so both agree on what counts
 * as a frontmatter block; YAML parsing policy stays with each caller.
 */

/** A detected leading `---` frontmatter block, split from the body. */
export interface FrontmatterBlock {
  /** Raw YAML text between the fences (no fences, no fence newlines). */
  yaml: string;
  /** Everything after the closing fence (not trimmed). */
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Split a leading `---`-fenced YAML frontmatter block from a document.
 * Returns null unless the input begins with a COMPLETE block — an
 * unterminated opening fence is not a block, so it stays in the body.
 */
export function splitFrontmatterBlock(input: string): FrontmatterBlock | null {
  const m = input.match(FRONTMATTER_RE);
  if (!m) return null;
  return { yaml: m[1] ?? "", body: m[2] ?? "" };
}
