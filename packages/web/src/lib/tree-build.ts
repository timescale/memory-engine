/**
 * Build a nested tree from a flat list of memories.
 *
 * Each memory's `tree` is an ltree-style dotted path (e.g. `work.projects.me`).
 * We build path nodes for every segment and memories as leaves under their
 * final segment. Memories with an empty `tree` live under a synthetic `.`
 * root so the UI can still group and show them.
 */
import type { MemoryWithScore } from "../api/types.ts";

export interface PathNode {
  kind: "path";
  /**
   * The full dotted path for this node. The synthetic root uses the literal
   * string `.` so that "expanded-path" sets have a single well-known key.
   */
  path: string;
  /** The last segment of `path`, used as the display label. */
  label: string;
  /** Depth in the tree, 0 = synthetic root. */
  depth: number;
  /** Child paths + memory leaves, sorted stably. */
  children: TreeNode[];
}

export interface MemoryLeaf {
  kind: "memory";
  id: string;
  title: string;
  tree: string;
  depth: number;
}

export type TreeNode = PathNode | MemoryLeaf;

/** Sentinel path used for memories with an empty `tree` string. */
export const ROOT_PATH = ".";

/**
 * Build a nested tree from the flat memory list.
 *
 * Always returns a single root `PathNode` with path `.`. When the input is
 * empty, the root has no children.
 */
export function buildTree(memories: MemoryWithScore[]): PathNode {
  const root: PathNode = {
    kind: "path",
    path: ROOT_PATH,
    label: ROOT_PATH,
    depth: 0,
    children: [],
  };
  const pathIndex = new Map<string, PathNode>();
  pathIndex.set(ROOT_PATH, root);

  for (const memory of memories) {
    const segments = memory.tree.length > 0 ? memory.tree.split(".") : [];
    let parent = root;

    // Create (or look up) each intermediate path node.
    let current = "";
    for (const segment of segments) {
      current = current.length === 0 ? segment : `${current}.${segment}`;
      let node = pathIndex.get(current);
      if (!node) {
        node = {
          kind: "path",
          path: current,
          label: segment,
          depth: parent.depth + 1,
          children: [],
        };
        pathIndex.set(current, node);
        parent.children.push(node);
      }
      parent = node;
    }

    parent.children.push({
      kind: "memory",
      id: memory.id,
      title: titleFor(memory),
      tree: memory.tree,
      depth: parent.depth + 1,
    });
  }

  sortRecursive(root);
  return root;
}

/**
 * Memory display title: the first non-empty line of `content`, trimmed to
 * ~60 chars. Falls back to the id suffix when content is empty.
 */
function titleFor(memory: MemoryWithScore): string {
  const firstLine = memory.content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine) {
    const withoutHeading = firstLine.replace(/^#+\s+/, "");
    return withoutHeading.length > 60
      ? `${withoutHeading.slice(0, 57).trimEnd()}…`
      : withoutHeading;
  }
  return memory.id.slice(-8);
}

/**
 * Sort children in place: path nodes first (alphabetical by label), then
 * memory leaves (alphabetical by title). Stable across re-renders.
 */
function sortRecursive(node: PathNode): void {
  node.children.sort(compareNodes);
  for (const child of node.children) {
    if (child.kind === "path") sortRecursive(child);
  }
}

function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === "path" ? -1 : 1;
  const aKey = a.kind === "path" ? a.label : a.title;
  const bKey = b.kind === "path" ? b.label : b.title;
  return aKey.localeCompare(bKey);
}

/**
 * Set of all path strings present in the tree. Used to preserve expansion
 * state across filter changes (drop stale paths, keep present ones).
 */
export function collectPaths(
  node: PathNode,
  into: Set<string> = new Set(),
): Set<string> {
  into.add(node.path);
  for (const child of node.children) {
    if (child.kind === "path") collectPaths(child, into);
  }
  return into;
}
