/**
 * Tests for YAML frontmatter + markdown body parsing.
 */

import { describe, expect, test } from "bun:test";
import type { MemoryResponse } from "@memory.build/client";
import { memoryToEditorText, parseEditorText } from "./frontmatter.ts";

function mkMemory(partial: Partial<MemoryResponse>): MemoryResponse {
  return {
    id: partial.id ?? "01234567-89ab-7cde-8fab-0123456789ab",
    content: partial.content ?? "body",
    meta: partial.meta ?? {},
    tree: partial.tree ?? "",
    name: partial.name ?? null,
    temporal: partial.temporal ?? null,
    hasEmbedding: partial.hasEmbedding ?? false,
    createdAt: partial.createdAt ?? "2026-01-01T00:00:00Z",
    createdBy: partial.createdBy ?? null,
    updatedAt: partial.updatedAt ?? null,
  };
}

describe("memoryToEditorText", () => {
  test("omits frontmatter entirely when nothing is editable", () => {
    const text = memoryToEditorText(mkMemory({ content: "hello" }));
    expect(text).toBe("hello");
  });

  test("emits name, tree, meta, and temporal when present", () => {
    const text = memoryToEditorText(
      mkMemory({
        content: "body text",
        name: "jwt-rotation",
        tree: "work.projects",
        meta: { priority: "high" },
        temporal: {
          start: "2026-01-01T00:00:00Z",
          end: "2026-06-30T00:00:00Z",
        },
      }),
    );
    expect(text).toContain("name: jwt-rotation");
    expect(text).toContain("tree: work.projects");
    expect(text).toContain("priority: high");
    expect(text).toContain("start: '2026-01-01T00:00:00Z'");
    expect(text.trimEnd().endsWith("body text")).toBe(true);
  });

  test("omits name when the memory is unnamed", () => {
    const text = memoryToEditorText(
      mkMemory({ content: "body", tree: "work" }),
    );
    expect(text).not.toContain("name:");
  });
});

describe("parseEditorText", () => {
  test("body-only input parses as empty frontmatter", () => {
    const parsed = parseEditorText("no frontmatter here");
    expect(parsed.name).toBeNull();
    expect(parsed.tree).toBe("");
    expect(parsed.meta).toEqual({});
    expect(parsed.temporal).toBeNull();
    expect(parsed.body).toBe("no frontmatter here");
  });

  test("standard object-form frontmatter round-trips", () => {
    const original = mkMemory({
      content: "hello world",
      name: "jwt-rotation",
      tree: "work.projects",
      meta: { a: 1, b: "two" },
      temporal: {
        start: "2026-01-01T00:00:00Z",
        end: "2026-06-30T00:00:00Z",
      },
    });
    const text = memoryToEditorText(original);
    const parsed = parseEditorText(text);
    expect(parsed.name).toBe("jwt-rotation");
    expect(parsed.tree).toBe("work.projects");
    expect(parsed.meta).toEqual({ a: 1, b: "two" });
    expect(parsed.temporal).toEqual(original.temporal);
    expect(parsed.body).toBe("hello world");
  });

  test("omitting name parses as null (clears the name on save)", () => {
    const parsed = parseEditorText("---\ntree: work\n---\nbody");
    expect(parsed.name).toBeNull();
  });

  test("invalid name (slash) throws", () => {
    expect(() => parseEditorText("---\nname: a/b\n---\nbody")).toThrow(
      /name.*slug/,
    );
  });

  test("accepts array-form temporal", () => {
    const source =
      "---\ntemporal:\n  - '2026-01-01T00:00:00Z'\n  - '2026-06-30T00:00:00Z'\n---\nbody";
    const parsed = parseEditorText(source);
    expect(parsed.temporal).toEqual({
      start: "2026-01-01T00:00:00Z",
      end: "2026-06-30T00:00:00Z",
    });
  });

  test("accepts string-form temporal (single timestamp)", () => {
    const parsed = parseEditorText(
      "---\ntemporal: '2026-01-01T00:00:00Z'\n---\nbody",
    );
    expect(parsed.temporal?.start).toBe("2026-01-01T00:00:00Z");
  });

  test("invalid YAML throws", () => {
    expect(() => parseEditorText("---\ntree: [unclosed\n---\nbody")).toThrow(
      /Invalid frontmatter YAML/,
    );
  });

  test("non-string tree throws", () => {
    expect(() => parseEditorText("---\ntree: 42\n---\nbody")).toThrow(
      /tree.*must be a string/,
    );
  });

  test("non-object meta throws", () => {
    expect(() =>
      parseEditorText("---\nmeta:\n  - 1\n  - 2\n---\nbody"),
    ).toThrow(/meta.*must be an object/);
  });
});
