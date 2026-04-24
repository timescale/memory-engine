/**
 * Build a nested tree from a flat list of memories.
 *
 * Each memory's `tree` is an ltree-style dotted path (e.g. `work.projects.me`).
 * Top-level path segments (`work`, `personal`, ...) render at depth 0 with
 * no indent — they are first-class citizens in the tree.
 *
 * Memories with an empty `tree` string are grouped under a synthetic path
 * node labelled `.` which appears as a sibling of the other top-level paths.
 * The synthetic node is only emitted when there is at least one root-level
 * memory to show, so clean trees don't get a dangling "root" bucket.
 */
import type { MemoryWithScore } from "../api/types.ts";

export interface PathNode {
  kind: "path";
  /**
   * The full dotted path for this node. The synthetic root uses the literal
   * string `.` so expanded-path sets have a single well-known key.
   */
  path: string;
  /** The last segment of `path`, used as the display label. */
  label: string;
  /** Depth in the tree — 0 for every top-level node, including `.`. */
  depth: number;
  /** Child paths + memory leaves, sorted stably. */
  children: TreeNode[];
}

export interface MemoryLeaf {
  kind: "memory";
  id: string;
  title: string;
  tree: string;
  /**
   * ISO timestamp for the memory's temporal range start, or null when the
   * memory has no temporal set. Drives leaf ordering within each path.
   */
  temporalStart: string | null;
  depth: number;
}

export type TreeNode = PathNode | MemoryLeaf;

/** Sentinel path used for memories with an empty `tree` string. */
export const ROOT_PATH = ".";

/**
 * Build the list of top-level tree nodes from the flat memory list.
 *
 * Returns an empty array when there are no memories. The synthetic `.`
 * node is appended last (after the alphabetically-sorted named paths) when
 * and only when at least one memory has an empty tree.
 */
export function buildTree(memories: MemoryWithScore[]): TreeNode[] {
  const topLevel: TreeNode[] = [];
  const pathIndex = new Map<string, PathNode>();
  const rootLeaves: MemoryLeaf[] = [];

  for (const memory of memories) {
    if (memory.tree.length === 0) {
      rootLeaves.push({
        kind: "memory",
        id: memory.id,
        title: titleFor(memory),
        tree: memory.tree,
        temporalStart: memory.temporal?.start ?? null,
        depth: 1, // nested inside the synthetic `.` parent
      });
      continue;
    }

    const segments = memory.tree.split(".");
    let parent: PathNode | null = null;
    let current = "";

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] as string;
      current = i === 0 ? segment : `${current}.${segment}`;
      let node = pathIndex.get(current);
      if (!node) {
        node = {
          kind: "path",
          path: current,
          label: segment,
          depth: i,
          children: [],
        };
        pathIndex.set(current, node);
        if (parent === null) topLevel.push(node);
        else parent.children.push(node);
      }
      parent = node;
    }

    // `parent` is non-null because `segments` is non-empty (empty tree handled above).
    const leafParent = parent as PathNode;
    leafParent.children.push({
      kind: "memory",
      id: memory.id,
      title: titleFor(memory),
      tree: memory.tree,
      temporalStart: memory.temporal?.start ?? null,
      depth: leafParent.depth + 1,
    });
  }

  if (rootLeaves.length > 0) {
    topLevel.push({
      kind: "path",
      path: ROOT_PATH,
      label: ROOT_PATH,
      depth: 0,
      children: rootLeaves,
    });
  }

  for (const node of topLevel) {
    if (node.kind === "path") sortRecursive(node);
  }
  topLevel.sort(compareTopLevel);
  return topLevel;
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
  // Paths always come before memory leaves.
  if (a.kind !== b.kind) return a.kind === "path" ? -1 : 1;

  // Paths sort alphabetically by label.
  if (a.kind === "path" && b.kind === "path") {
    return a.label.localeCompare(b.label);
  }

  // Memory leaves sort by temporal start descending (newest first). Memories
  // with no temporal sort after those with one. Ties break on title so the
  // order is deterministic across re-renders.
  if (a.kind === "memory" && b.kind === "memory") {
    if (a.temporalStart === null && b.temporalStart !== null) return 1;
    if (a.temporalStart !== null && b.temporalStart === null) return -1;
    if (a.temporalStart !== null && b.temporalStart !== null) {
      const cmp = b.temporalStart.localeCompare(a.temporalStart);
      if (cmp !== 0) return cmp;
    }
    return a.title.localeCompare(b.title);
  }

  return 0;
}

/**
 * Top-level ordering: named paths alphabetically, synthetic `.` always last
 * so the "unfiled" bucket doesn't crowd out the organized hierarchy.
 */
function compareTopLevel(a: TreeNode, b: TreeNode): number {
  const aIsRoot = a.kind === "path" && a.path === ROOT_PATH;
  const bIsRoot = b.kind === "path" && b.path === ROOT_PATH;
  if (aIsRoot && !bIsRoot) return 1;
  if (!aIsRoot && bIsRoot) return -1;
  return compareNodes(a, b);
}

/**
 * Collect every path string present in the tree. Used to preserve
 * expansion state across filter changes (drop stale paths, keep present ones).
 */
export function collectPaths(
  roots: TreeNode[],
  into: Set<string> = new Set(),
): Set<string> {
  for (const root of roots) {
    if (root.kind === "path") collectPathsFromNode(root, into);
  }
  return into;
}

function collectPathsFromNode(node: PathNode, into: Set<string>): void {
  into.add(node.path);
  for (const child of node.children) {
    if (child.kind === "path") collectPathsFromNode(child, into);
  }
}
