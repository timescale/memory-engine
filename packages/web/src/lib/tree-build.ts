/**
 * Build a nested path hierarchy from the flat `memory.tree` response.
 *
 * The `memory.tree` RPC returns every distinct prefix of every memory's
 * tree with an aggregate count (memory count under `path` OR at `path`).
 * From that flat list we build:
 *
 *   - `PathNode` per path, with `aggregateCount` (from the RPC) and
 *     `directCount` (memories at exactly this path, derived as
 *     `aggregateCount - Σ children.aggregateCount`).
 *   - Top-level siblings for every first-label path (`work`, `personal`, …).
 *   - A synthetic `.` node appended last when the caller passed a non-zero
 *     `rootLeafCount` — i.e., memories exist with an empty tree. The
 *     `memory.tree` RPC excludes empty trees, so that count has to come in
 *     separately.
 *
 * Memory leaves are intentionally NOT part of this structure. They're
 * fetched lazily per expanded path and merged in at render time, so a
 * repo with millions of memories can still render its full path hierarchy
 * without pulling any content.
 */
import type {
  MemoryWithScoreResponse,
  TreeNodeResponse,
} from "@memory.build/client";

export interface PathNode {
  kind: "path";
  /** Full dotted path; the literal string `.` for the synthetic root bucket. */
  path: string;
  /** Last segment of `path`, used as the display label. */
  label: string;
  /** Depth (top-level nodes are 0). */
  depth: number;
  /**
   * Memories under this path, including descendants. Straight from
   * `memory.tree` for normal paths; equals the root-leaf count for `.`.
   */
  aggregateCount: number;
  /**
   * Memories that live at exactly this path (no descendants). Useful for
   * deciding whether expanding the path will produce any leaves.
   */
  directCount: number;
  /** Nested sub-paths. Sorted alphabetically by label. */
  children: PathNode[];
  /**
   * Leaves that are already loaded and should render inline without a
   * lazy fetch. Populated by {@link buildSearchTree} (search mode) and
   * left undefined by {@link buildPathTree} (browse mode, lazy-loaded).
   */
  inlineLeaves?: MemoryLeaf[];
}

export interface MemoryLeaf {
  kind: "memory";
  id: string;
  title: string;
  tree: string;
  /** ISO timestamp of the memory's temporal range start, or null. */
  temporalStart: string | null;
  /** Depth in the tree at render time (set by the caller). */
  depth: number;
}

/** Sentinel path for the synthetic "empty tree" bucket. */
export const ROOT_PATH = ".";

/**
 * Build the top-level path hierarchy from the flat tree RPC response.
 *
 * @param treeNodes   Flat path/count entries from `memory.tree`.
 * @param rootLeafCount Number of memories whose tree is exactly empty.
 *                      When >0 the synthetic `.` node is appended last.
 */
export function buildPathTree(
  treeNodes: TreeNodeResponse[],
  rootLeafCount: number,
): PathNode[] {
  const byPath = new Map<string, PathNode>();
  const topLevel: PathNode[] = [];

  // Sort so ancestors are processed before descendants. Critical for the
  // child-attachment logic below.
  const sorted = [...treeNodes].sort((a, b) => a.path.localeCompare(b.path));

  for (const { path, count } of sorted) {
    const segments = path.split(".");
    const label = segments[segments.length - 1] as string;
    const depth = segments.length - 1;
    const node: PathNode = {
      kind: "path",
      path,
      label,
      depth,
      aggregateCount: count,
      directCount: count, // refined below
      children: [],
    };
    byPath.set(path, node);

    if (depth === 0) {
      topLevel.push(node);
    } else {
      const parentPath = segments.slice(0, -1).join(".");
      const parent = byPath.get(parentPath);
      if (parent) parent.children.push(node);
      // If no parent (shouldn't happen with well-formed tree RPC output),
      // drop the orphan silently rather than rendering a phantom root.
    }
  }

  // Now that children are attached, compute directCount per node.
  for (const node of byPath.values()) {
    const childSum = node.children.reduce(
      (sum, c) => sum + c.aggregateCount,
      0,
    );
    node.directCount = node.aggregateCount - childSum;
  }

  // Recursively sort children alphabetically.
  for (const node of topLevel) sortPathChildren(node);

  if (rootLeafCount > 0) {
    topLevel.push({
      kind: "path",
      path: ROOT_PATH,
      label: ROOT_PATH,
      depth: 0,
      aggregateCount: rootLeafCount,
      directCount: rootLeafCount,
      children: [],
    });
  }

  topLevel.sort(compareTopLevel);
  return topLevel;
}

function sortPathChildren(node: PathNode): void {
  node.children.sort((a, b) => a.label.localeCompare(b.label));
  for (const child of node.children) sortPathChildren(child);
}

function compareTopLevel(a: PathNode, b: PathNode): number {
  const aIsRoot = a.path === ROOT_PATH;
  const bIsRoot = b.path === ROOT_PATH;
  if (aIsRoot && !bIsRoot) return 1;
  if (!aIsRoot && bIsRoot) return -1;
  return a.label.localeCompare(b.label);
}

/**
 * Set of every path string in the tree. Used to prune stale expanded
 * paths from the UI store after the tree reloads.
 */
export function collectPaths(
  roots: PathNode[],
  into: Set<string> = new Set(),
): Set<string> {
  for (const root of roots) walkPaths(root, into);
  return into;
}

function walkPaths(node: PathNode, into: Set<string>): void {
  into.add(node.path);
  for (const child of node.children) walkPaths(child, into);
}

/**
 * Convert a fetched memory into the lightweight `MemoryLeaf` the tree
 * view renders. Depth is supplied by the caller since leaves are grafted
 * onto the tree at render time.
 */
export function memoryToLeaf(
  memory: MemoryWithScoreResponse,
  depth: number,
): MemoryLeaf {
  return {
    kind: "memory",
    id: memory.id,
    title: titleForMemory(memory.content, memory.id),
    tree: memory.tree,
    temporalStart: memory.temporal?.start ?? null,
    depth,
  };
}

/**
 * Sort a list of leaves in place-friendly (returns new array) temporal-desc
 * order, null temporals last, title tiebreak.
 */
export function sortLeaves(leaves: MemoryLeaf[]): MemoryLeaf[] {
  return [...leaves].sort(compareLeaves);
}

/**
 * Build a tree view from a flat list of search results (search mode).
 *
 * Unlike {@link buildPathTree}, the input is actual memory objects — we
 * know the full content, so every leaf is materialized inline and no
 * lazy fetch is needed. Paths are created for every segment along each
 * memory's tree; the synthetic `.` bucket captures memories with an
 * empty tree.
 *
 * `aggregateCount` is the total number of matching memories under a
 * path (including descendants); `directCount` is the number matching at
 * exactly that path. Both are derived from the supplied memory set, not
 * the full engine — they reflect what's visible in the current search.
 */
export function buildSearchTree(
  memories: MemoryWithScoreResponse[],
): PathNode[] {
  const topLevel: PathNode[] = [];
  const byPath = new Map<string, PathNode>();
  const rootLeaves: MemoryLeaf[] = [];

  function ensurePath(
    path: string,
    label: string,
    depth: number,
    parent: PathNode | null,
  ): PathNode {
    const existing = byPath.get(path);
    if (existing) return existing;
    const node: PathNode = {
      kind: "path",
      path,
      label,
      depth,
      aggregateCount: 0,
      directCount: 0,
      children: [],
      inlineLeaves: [],
    };
    byPath.set(path, node);
    if (parent === null) topLevel.push(node);
    else parent.children.push(node);
    return node;
  }

  for (const memory of memories) {
    if (memory.tree.length === 0) {
      rootLeaves.push(memoryToLeaf(memory, 1));
      continue;
    }

    const segments = memory.tree.split(".");
    let parent: PathNode | null = null;
    let current = "";
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i] as string;
      current = i === 0 ? seg : `${current}.${seg}`;
      parent = ensurePath(current, seg, i, parent);
      parent.aggregateCount += 1;
    }

    const leafParent = parent as PathNode;
    leafParent.directCount += 1;
    (leafParent.inlineLeaves as MemoryLeaf[]).push(
      memoryToLeaf(memory, leafParent.depth + 1),
    );
  }

  // Sort inline leaves + children recursively.
  for (const node of byPath.values()) {
    if (node.inlineLeaves && node.inlineLeaves.length > 0) {
      node.inlineLeaves = sortLeaves(node.inlineLeaves);
    }
    node.children.sort((a, b) => a.label.localeCompare(b.label));
  }

  if (rootLeaves.length > 0) {
    topLevel.push({
      kind: "path",
      path: ROOT_PATH,
      label: ROOT_PATH,
      depth: 0,
      aggregateCount: rootLeaves.length,
      directCount: rootLeaves.length,
      children: [],
      inlineLeaves: sortLeaves(rootLeaves),
    });
  }

  topLevel.sort(compareTopLevel);
  return topLevel;
}

function compareLeaves(a: MemoryLeaf, b: MemoryLeaf): number {
  if (a.temporalStart === null && b.temporalStart !== null) return 1;
  if (a.temporalStart !== null && b.temporalStart === null) return -1;
  if (a.temporalStart !== null && b.temporalStart !== null) {
    const cmp = b.temporalStart.localeCompare(a.temporalStart);
    if (cmp !== 0) return cmp;
  }
  return a.title.localeCompare(b.title);
}

/**
 * First non-empty line of `content`, stripped of leading markdown heading
 * chars and truncated to ~60 chars. Falls back to the last 8 chars of the
 * memory id when content is empty.
 */
export function titleForMemory(content: string, fallbackId: string): string {
  const firstLine = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine) {
    const withoutHeading = firstLine.replace(/^#+\s+/, "");
    return withoutHeading.length > 60
      ? `${withoutHeading.slice(0, 57).trimEnd()}…`
      : withoutHeading;
  }
  return fallbackId.slice(-8);
}
