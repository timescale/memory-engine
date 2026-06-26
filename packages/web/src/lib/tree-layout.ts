/**
 * Tree-row indentation, matching the "Console" handoff rhythm:
 *   root path (depth 0)   → 10px
 *   child path (depth 1)  → 26px
 *   memory leaf (depth 2) → 44px
 *
 * Path rows step by a fixed indent per level; a memory leaf sits one indent
 * deeper than its parent path plus the room its bullet needs.
 */
const TREE_BASE_PX = 10;
const TREE_INDENT_PX = 16;
const LEAF_BULLET_INSET_PX = 18;

/** Left padding for a path (folder) row at the given depth. */
export function pathRowPaddingLeft(depth: number): string {
  return `${TREE_BASE_PX + depth * TREE_INDENT_PX}px`;
}

/** Left padding for a memory-leaf row at the given depth. */
export function leafRowPaddingLeft(depth: number): string {
  return `${TREE_BASE_PX + Math.max(0, depth - 1) * TREE_INDENT_PX + LEAF_BULLET_INSET_PX}px`;
}
