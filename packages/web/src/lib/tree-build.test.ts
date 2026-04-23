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
  test("empty input returns a root with no children", () => {
    const root = buildTree([]);
    expect(root.kind).toBe("path");
    expect(root.path).toBe(ROOT_PATH);
    expect(root.depth).toBe(0);
    expect(root.children).toEqual([]);
  });

  test("memories with empty tree hang off the synthetic root", () => {
    const root = buildTree([
      mkMemory({ id: "m1", content: "hello", tree: "" }),
      mkMemory({ id: "m2", content: "world", tree: "" }),
    ]);
    expect(root.children).toHaveLength(2);
    expect(root.children.every((c) => c.kind === "memory")).toBe(true);
  });

  test("nested paths create intermediate nodes", () => {
    const root = buildTree([
      mkMemory({ id: "m1", content: "note", tree: "work.projects.me" }),
    ]);
    const work = root.children[0];
    if (!work || work.kind !== "path") throw new Error("expected path node");
    expect(work.path).toBe("work");
    expect(work.depth).toBe(1);

    const projects = work.children[0];
    if (!projects || projects.kind !== "path") throw new Error("expected path");
    expect(projects.path).toBe("work.projects");

    const me = projects.children[0];
    if (!me || me.kind !== "path") throw new Error("expected path");
    expect(me.path).toBe("work.projects.me");
    expect(me.children).toHaveLength(1);
    expect(me.children[0]?.kind).toBe("memory");
  });

  test("paths and memories are sorted with paths first", () => {
    const root = buildTree([
      mkMemory({ id: "m1", content: "zzz note", tree: "" }),
      mkMemory({ id: "m2", content: "aaa note", tree: "" }),
      mkMemory({ id: "m3", content: "grouped", tree: "work" }),
    ]);
    expect(root.children.map((c) => c.kind)).toEqual([
      "path",
      "memory",
      "memory",
    ]);
    expect(
      root.children.filter((c) => c.kind === "memory").map((c) => c.title),
    ).toEqual(["aaa note", "zzz note"]);
  });

  test("titles use the first non-empty line and strip markdown headings", () => {
    const root = buildTree([
      mkMemory({
        id: "m1",
        content: "\n\n# Hello World\n\nbody text",
        tree: "",
      }),
    ]);
    const leaf = root.children[0];
    if (!leaf || leaf.kind !== "memory") throw new Error("expected memory");
    expect(leaf.title).toBe("Hello World");
  });

  test("titles are truncated to ~60 chars with an ellipsis", () => {
    const longLine = "x".repeat(200);
    const root = buildTree([mkMemory({ content: longLine, tree: "" })]);
    const leaf = root.children[0];
    if (!leaf || leaf.kind !== "memory") throw new Error("expected memory");
    expect(leaf.title.length).toBeLessThanOrEqual(60);
    expect(leaf.title.endsWith("…")).toBe(true);
  });

  test("empty content falls back to id suffix", () => {
    const id = "abcdef12-1234-7abc-8abc-1234567890ab";
    const root = buildTree([mkMemory({ id, content: "  \n  ", tree: "" })]);
    const leaf = root.children[0];
    if (!leaf || leaf.kind !== "memory") throw new Error("expected memory");
    expect(leaf.title).toBe(id.slice(-8));
  });
});

describe("collectPaths", () => {
  test("returns every path node, including the synthetic root", () => {
    const root = buildTree([
      mkMemory({ id: "m1", content: "a", tree: "work.projects" }),
      mkMemory({ id: "m2", content: "b", tree: "personal" }),
    ]);
    const paths = collectPaths(root);
    expect(paths.has(ROOT_PATH)).toBe(true);
    expect(paths.has("work")).toBe(true);
    expect(paths.has("work.projects")).toBe(true);
    expect(paths.has("personal")).toBe(true);
  });
});
