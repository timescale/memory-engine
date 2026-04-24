/**
 * Tests for the pure tree-building logic.
 */

import { describe, expect, test } from "bun:test";
import type {
  MemoryWithScoreResponse,
  TreeNodeResponse,
} from "@memory.build/client";
import {
  buildPathTree,
  buildSearchTree,
  collectPaths,
  memoryToLeaf,
  ROOT_PATH,
  sortLeaves,
  titleForMemory,
} from "./tree-build.ts";

function mkTreeNode(path: string, count: number): TreeNodeResponse {
  return { path, count };
}

function mkMemory(
  partial: Partial<MemoryWithScoreResponse>,
): MemoryWithScoreResponse {
  return {
    id: partial.id ?? crypto.randomUUID(),
    content: partial.content ?? "placeholder content",
    meta: partial.meta ?? {},
    tree: partial.tree ?? "",
    temporal: partial.temporal ?? null,
    hasEmbedding: partial.hasEmbedding ?? false,
    createdAt: partial.createdAt ?? new Date().toISOString(),
    createdBy: partial.createdBy ?? null,
    updatedAt: partial.updatedAt ?? null,
    score: partial.score ?? 0,
  };
}

describe("buildPathTree", () => {
  test("empty tree returns an empty top-level array", () => {
    expect(buildPathTree([], 0)).toEqual([]);
  });

  test("named top-level paths appear at depth 0", () => {
    const roots = buildPathTree(
      [mkTreeNode("projects", 3), mkTreeNode("personal", 2)],
      0,
    );
    expect(roots.map((r) => r.path)).toEqual(["personal", "projects"]);
    expect(roots.every((r) => r.depth === 0)).toBe(true);
  });

  test("synthetic `.` is omitted when rootLeafCount is 0", () => {
    const roots = buildPathTree([mkTreeNode("work", 1)], 0);
    expect(roots.some((r) => r.path === ROOT_PATH)).toBe(false);
  });

  test("synthetic `.` is appended last when rootLeafCount > 0", () => {
    const roots = buildPathTree([mkTreeNode("work", 1)], 3);
    expect(roots).toHaveLength(2);
    const last = roots[roots.length - 1];
    expect(last?.path).toBe(ROOT_PATH);
    expect(last?.depth).toBe(0);
    expect(last?.aggregateCount).toBe(3);
    expect(last?.directCount).toBe(3);
  });

  test("nested paths are attached as children", () => {
    const roots = buildPathTree(
      [
        mkTreeNode("work", 2),
        mkTreeNode("work.projects", 1),
        mkTreeNode("work.projects.me", 1),
      ],
      0,
    );
    expect(roots).toHaveLength(1);
    const work = roots[0];
    expect(work?.path).toBe("work");
    expect(work?.depth).toBe(0);
    const projects = work?.children[0];
    expect(projects?.path).toBe("work.projects");
    expect(projects?.depth).toBe(1);
    const me = projects?.children[0];
    expect(me?.path).toBe("work.projects.me");
    expect(me?.depth).toBe(2);
  });

  test("directCount = aggregateCount - sum(child.aggregateCount)", () => {
    // work has 3 total: 1 direct + 2 under work.projects (both descendants of projects)
    // work.projects has 2 total: 0 direct + both in work.projects.a and .b
    const roots = buildPathTree(
      [
        mkTreeNode("work", 3),
        mkTreeNode("work.projects", 2),
        mkTreeNode("work.projects.a", 1),
        mkTreeNode("work.projects.b", 1),
      ],
      0,
    );
    const work = roots[0];
    expect(work?.aggregateCount).toBe(3);
    expect(work?.directCount).toBe(1); // 3 - 2

    const projects = work?.children[0];
    expect(projects?.aggregateCount).toBe(2);
    expect(projects?.directCount).toBe(0); // 2 - (1+1)

    const leafA = projects?.children[0];
    expect(leafA?.directCount).toBe(1); // 1 - 0 (no children)
  });

  test("siblings are sorted alphabetically", () => {
    const roots = buildPathTree(
      [mkTreeNode("zzz", 1), mkTreeNode("aaa", 1), mkTreeNode("mmm", 1)],
      0,
    );
    expect(roots.map((r) => r.path)).toEqual(["aaa", "mmm", "zzz"]);
  });

  test("synthetic `.` sorts after named paths even alphabetically", () => {
    const roots = buildPathTree([mkTreeNode("a", 1), mkTreeNode("z", 1)], 1);
    expect(roots.map((r) => r.path)).toEqual(["a", "z", ROOT_PATH]);
  });
});

describe("buildSearchTree", () => {
  test("empty input returns an empty array", () => {
    expect(buildSearchTree([])).toEqual([]);
  });

  test("groups memories by tree path with inline leaves", () => {
    const roots = buildSearchTree([
      mkMemory({ id: "a", content: "alpha", tree: "work" }),
      mkMemory({ id: "b", content: "beta", tree: "work.projects" }),
    ]);
    expect(roots).toHaveLength(1);
    const work = roots[0];
    expect(work?.path).toBe("work");
    expect(work?.aggregateCount).toBe(2); // self + descendant
    expect(work?.directCount).toBe(1); // only memory `a`
    expect(work?.inlineLeaves?.map((l) => l.title)).toEqual(["alpha"]);

    const projects = work?.children[0];
    expect(projects?.path).toBe("work.projects");
    expect(projects?.aggregateCount).toBe(1);
    expect(projects?.directCount).toBe(1);
    expect(projects?.inlineLeaves?.map((l) => l.title)).toEqual(["beta"]);
  });

  test("memories with empty tree populate the synthetic `.` bucket", () => {
    const roots = buildSearchTree([
      mkMemory({ id: "a", content: "rooty", tree: "" }),
      mkMemory({ id: "b", content: "grouped", tree: "work" }),
    ]);
    expect(roots).toHaveLength(2);
    const last = roots[roots.length - 1];
    expect(last?.path).toBe(ROOT_PATH);
    expect(last?.inlineLeaves?.map((l) => l.title)).toEqual(["rooty"]);
  });

  test("inline leaves are sorted newest-first by temporal", () => {
    const roots = buildSearchTree([
      mkMemory({
        content: "old",
        tree: "notes",
        temporal: {
          start: "2024-01-01T00:00:00Z",
          end: "2024-01-01T00:00:00Z",
        },
      }),
      mkMemory({
        content: "new",
        tree: "notes",
        temporal: {
          start: "2026-01-01T00:00:00Z",
          end: "2026-01-01T00:00:00Z",
        },
      }),
    ]);
    const notes = roots[0];
    expect(notes?.inlineLeaves?.map((l) => l.title)).toEqual(["new", "old"]);
  });

  test("aggregateCount counts every ancestor hit", () => {
    const roots = buildSearchTree([
      mkMemory({ id: "a", content: "x", tree: "work.projects.me" }),
      mkMemory({ id: "b", content: "y", tree: "work.projects.you" }),
      mkMemory({ id: "c", content: "z", tree: "work.notes" }),
    ]);
    const work = roots[0];
    expect(work?.aggregateCount).toBe(3);
    expect(work?.directCount).toBe(0);

    const projects = work?.children.find((c) => c.path === "work.projects");
    expect(projects?.aggregateCount).toBe(2);

    const notes = work?.children.find((c) => c.path === "work.notes");
    expect(notes?.aggregateCount).toBe(1);
    expect(notes?.directCount).toBe(1);
  });
});

describe("collectPaths", () => {
  test("returns every path, including the synthetic `.`", () => {
    const roots = buildPathTree(
      [
        mkTreeNode("work", 2),
        mkTreeNode("work.projects", 1),
        mkTreeNode("personal", 1),
      ],
      2,
    );
    const paths = collectPaths(roots);
    expect(paths.has("work")).toBe(true);
    expect(paths.has("work.projects")).toBe(true);
    expect(paths.has("personal")).toBe(true);
    expect(paths.has(ROOT_PATH)).toBe(true);
  });

  test("empty tree yields an empty set", () => {
    expect(collectPaths(buildPathTree([], 0)).size).toBe(0);
  });
});

describe("memoryToLeaf + sortLeaves + titleForMemory", () => {
  test("memoryToLeaf extracts the display title + temporal start", () => {
    const leaf = memoryToLeaf(
      mkMemory({
        id: "m1",
        content: "# Hello World\n\nbody",
        tree: "notes",
        temporal: {
          start: "2025-01-01T00:00:00Z",
          end: "2025-01-01T00:00:00Z",
        },
      }),
      2,
    );
    expect(leaf.title).toBe("Hello World");
    expect(leaf.temporalStart).toBe("2025-01-01T00:00:00Z");
    expect(leaf.depth).toBe(2);
  });

  test("sortLeaves: newest temporal first, nulls last, title tiebreak", () => {
    const leaves = [
      memoryToLeaf(
        mkMemory({
          content: "z",
          temporal: {
            start: "2025-01-01T00:00:00Z",
            end: "2025-01-01T00:00:00Z",
          },
        }),
        0,
      ),
      memoryToLeaf(mkMemory({ content: "no ts" }), 0),
      memoryToLeaf(
        mkMemory({
          content: "a",
          temporal: {
            start: "2025-01-01T00:00:00Z",
            end: "2025-01-01T00:00:00Z",
          },
        }),
        0,
      ),
      memoryToLeaf(
        mkMemory({
          content: "newest",
          temporal: {
            start: "2026-01-01T00:00:00Z",
            end: "2026-01-01T00:00:00Z",
          },
        }),
        0,
      ),
    ];
    const sorted = sortLeaves(leaves).map((l) => l.title);
    expect(sorted).toEqual(["newest", "a", "z", "no ts"]);
  });

  test("titleForMemory: strips markdown heading, truncates long lines, id fallback", () => {
    expect(titleForMemory("# hi", "x")).toBe("hi");
    const long = "x".repeat(200);
    const t = titleForMemory(long, "x");
    expect(t.length).toBeLessThanOrEqual(60);
    expect(t.endsWith("…")).toBe(true);

    expect(
      titleForMemory("  \n  ", "abcdef12-1234-7abc-8abc-1234567890ab"),
    ).toBe("1234567890ab".slice(-8));
  });
});
