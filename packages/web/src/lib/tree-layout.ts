const TREE_ROW_BASE_PADDING_PX = 8;
export const TREE_ROW_INDENT_PX = 16;

export function treeRowPaddingLeft(depth: number): string {
  return `${TREE_ROW_BASE_PADDING_PX + depth * TREE_ROW_INDENT_PX}px`;
}
