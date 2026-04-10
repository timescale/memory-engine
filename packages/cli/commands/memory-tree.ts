/**
 * Tree renderer — builds and renders hierarchical tree views
 * from flat node data returned by memory.tree RPC.
 *
 * Uses box-drawing characters for human-readable output.
 */

interface TreeViewNode {
  path: string;
  count: number;
}

interface TreeNode {
  label: string;
  count: number;
  children: TreeNode[];
}

/**
 * Build a nested tree from flat path/count pairs.
 */
function buildTree(nodes: TreeViewNode[]): TreeNode[] {
  if (nodes.length === 0) return [];

  const depths = nodes.map((n) => n.path.split(".").length);
  const minDepth = Math.min(...depths);

  const roots: TreeNode[] = [];
  const byPath = new Map<string, TreeNode>();

  const sorted = [...nodes].sort((a, b) => a.path.localeCompare(b.path));

  for (const node of sorted) {
    const parts = node.path.split(".");
    const lastPart = parts[parts.length - 1];
    const treeNode: TreeNode = {
      label: lastPart ?? node.path,
      count: node.count,
      children: [],
    };
    byPath.set(node.path, treeNode);

    if (parts.length === minDepth) {
      roots.push(treeNode);
    } else {
      const parentPath = parts.slice(0, -1).join(".");
      const parent = byPath.get(parentPath);
      if (parent) {
        parent.children.push(treeNode);
      } else {
        roots.push(treeNode);
      }
    }
  }

  return roots;
}

/**
 * Render a tree to a string with box-drawing characters.
 *
 * Output example:
 * ```
 * . (45)
 * ├── work (20)
 * │   ├── projects (15)
 * │   └── notes (5)
 * └── personal (25)
 *
 * 45 memories total
 * ```
 */
export function renderTree(
  nodes: TreeViewNode[],
  total: number,
  filter?: string,
): string {
  if (total === 0) {
    return "No memories found.";
  }

  const filteredNodes = filter ? nodes.filter((n) => n.path !== filter) : nodes;
  const tree = buildTree(filteredNodes);
  const lines: string[] = [];

  const rootLabel = filter || ".";
  lines.push(`${rootLabel} (${total})`);

  function render(children: TreeNode[], prefix: string): void {
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as TreeNode;
      const isLast = i === children.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const extension = isLast ? "    " : "│   ";

      lines.push(`${prefix}${connector}${child.label} (${child.count})`);
      render(child.children, `${prefix}${extension}`);
    }
  }

  render(tree, "");

  lines.push("");
  lines.push(`${total} ${total === 1 ? "memory" : "memories"} total`);

  return lines.join("\n");
}
