/**
 * Tests for the pure tree-building logic.
 *
 * These are plain unit tests — no React, no DOM. Run with `bun test`.
 */
import { describe, expect, test } from "bun:test";
import type { MemoryWithScore } from "../api/types.ts";
import { buildTree, collectPaths, ROOT_PATH } from "./tree-build.ts";

function mkMemory(partial: Partial<MemoryWithScore>): MemoryWithScore {
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

describe("buildTree", () => {
  test("empty input returns an empty top-level array", () => {
    expect(buildTree([])).toEqual([]);
  });

  test("named top-level paths appear at depth 0", () => {
    const roots = buildTree([
      mkMemory({ id: "m1", content: "a", tree: "projects" }),
      mkMemory({ id: "m2", content: "b", tree: "personal" }),
    ]);
    expect(roots).toHaveLength(2);
    expect(roots.map((r) => (r.kind === "path" ? r.path : null))).toEqual([
      "personal",
      "projects",
    ]);
    expect(roots.every((r) => r.kind === "path" && r.depth === 0)).toBe(true);
  });

  test("synthetic `.` node is omitted when no memories have empty tree", () => {
    const roots = buildTree([
      mkMemory({ id: "m1", content: "a", tree: "projects" }),
    ]);
    expect(roots.some((r) => r.kind === "path" && r.path === ROOT_PATH)).toBe(
      false,
    );
  });

  test("synthetic `.` node appears as the last top-level sibling when root leaves exist", () => {
    const roots = buildTree([
      mkMemory({ id: "m1", content: "a", tree: "projects" }),
      mkMemory({ id: "m2", content: "loose note", tree: "" }),
    ]);
    expect(roots).toHaveLength(2);
    const last = roots[roots.length - 1];
    expect(last?.kind).toBe("path");
    if (last?.kind === "path") {
      expect(last.path).toBe(ROOT_PATH);
      expect(last.depth).toBe(0);
      expect(last.children).toHaveLength(1);
      expect(last.children[0]?.kind).toBe("memory");
    }
  });

  test("nested paths create intermediate nodes with increasing depth", () => {
    const roots = buildTree([
      mkMemory({ id: "m1", content: "note", tree: "work.projects.me" }),
    ]);
    expect(roots).toHaveLength(1);
    const work = roots[0];
    if (!work || work.kind !== "path") throw new Error("expected path");
    expect(work.path).toBe("work");
    expect(work.depth).toBe(0);

    const projects = work.children[0];
    if (!projects || projects.kind !== "path") throw new Error("expected path");
    expect(projects.path).toBe("work.projects");
    expect(projects.depth).toBe(1);

    const me = projects.children[0];
    if (!me || me.kind !== "path") throw new Error("expected path");
    expect(me.path).toBe("work.projects.me");
    expect(me.depth).toBe(2);
    expect(me.children).toHaveLength(1);
    expect(me.children[0]?.kind).toBe("memory");
  });

  test("root-leaf titles are sorted alphabetically under the `.` node", () => {
    const roots = buildTree([
      mkMemory({ id: "m1", content: "zzz note", tree: "" }),
      mkMemory({ id: "m2", content: "aaa note", tree: "" }),
    ]);
    expect(roots).toHaveLength(1);
    const rootBucket = roots[0];
    if (!rootBucket || rootBucket.kind !== "path") {
      throw new Error("expected path");
    }
    expect(
      rootBucket.children
        .filter((c) => c.kind === "memory")
        .map((c) => c.title),
    ).toEqual(["aaa note", "zzz note"]);
  });

  test("within a path, sub-paths are listed before memory leaves", () => {
    const roots = buildTree([
      mkMemory({ id: "m1", content: "direct note", tree: "work" }),
      mkMemory({ id: "m2", content: "nested", tree: "work.projects" }),
    ]);
    const work = roots[0];
    if (!work || work.kind !== "path") throw new Error("expected path");
    expect(work.children.map((c) => c.kind)).toEqual(["path", "memory"]);
  });

  test("titles use the first non-empty line and strip markdown headings", () => {
    const roots = buildTree([
      mkMemory({
        id: "m1",
        content: "\n\n# Hello World\n\nbody text",
        tree: "notes",
      }),
    ]);
    const notes = roots[0];
    if (!notes || notes.kind !== "path") throw new Error("expected path");
    const leaf = notes.children[0];
    if (!leaf || leaf.kind !== "memory") throw new Error("expected memory");
    expect(leaf.title).toBe("Hello World");
  });

  test("titles are truncated to ~60 chars with an ellipsis", () => {
    const longLine = "x".repeat(200);
    const roots = buildTree([mkMemory({ content: longLine, tree: "notes" })]);
    const notes = roots[0];
    if (!notes || notes.kind !== "path") throw new Error("expected path");
    const leaf = notes.children[0];
    if (!leaf || leaf.kind !== "memory") throw new Error("expected memory");
    expect(leaf.title.length).toBeLessThanOrEqual(60);
    expect(leaf.title.endsWith("…")).toBe(true);
  });

  test("empty content falls back to id suffix", () => {
    const id = "abcdef12-1234-7abc-8abc-1234567890ab";
    const roots = buildTree([mkMemory({ id, content: "  \n  ", tree: "" })]);
    const rootBucket = roots[0];
    if (!rootBucket || rootBucket.kind !== "path") {
      throw new Error("expected path");
    }
    const leaf = rootBucket.children[0];
    if (!leaf || leaf.kind !== "memory") throw new Error("expected memory");
    expect(leaf.title).toBe(id.slice(-8));
  });
});

describe("collectPaths", () => {
  test("returns every path node across every top-level root", () => {
    const roots = buildTree([
      mkMemory({ id: "m1", content: "a", tree: "work.projects" }),
      mkMemory({ id: "m2", content: "b", tree: "personal" }),
      mkMemory({ id: "m3", content: "loose", tree: "" }),
    ]);
    const paths = collectPaths(roots);
    expect(paths.has("work")).toBe(true);
    expect(paths.has("work.projects")).toBe(true);
    expect(paths.has("personal")).toBe(true);
    expect(paths.has(ROOT_PATH)).toBe(true);
  });

  test("omits the synthetic `.` when no root leaves exist", () => {
    const roots = buildTree([
      mkMemory({ id: "m1", content: "a", tree: "work" }),
    ]);
    const paths = collectPaths(roots);
    expect(paths.has(ROOT_PATH)).toBe(false);
    expect(paths.has("work")).toBe(true);
  });

  test("returns an empty set for an empty tree", () => {
    expect(collectPaths(buildTree([])).size).toBe(0);
  });
});
