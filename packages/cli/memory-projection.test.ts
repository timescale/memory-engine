import { describe, expect, test } from "bun:test";
import {
  parseSelectFields,
  projectMemory,
  projectSearchResult,
  selectFieldSpecSchema,
  selectSchema,
} from "./memory-projection.ts";

const memory = {
  id: "0194a000-0001-7000-8000-000000000001",
  content: "ab😀cdefghij",
  meta: {
    source: "docs",
    $thread: "thread-1",
    "build-id": 42,
    "some.key": true,
  },
  tree: "/share/design",
  name: "projection",
  temporal: null,
  version: 2,
  versionHash: "a".repeat(32),
  hasEmbedding: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: null,
  updatedAt: null,
  score: 2.5,
};

describe("selectSchema", () => {
  test("accepts every bare response field", () => {
    for (const field of [
      "id",
      "content",
      "meta",
      "tree",
      "name",
      "temporal",
      "score",
      "hasEmbedding",
      "createdAt",
      "createdBy",
      "updatedAt",
      "version",
      "versionHash",
    ]) {
      expect(selectFieldSpecSchema.safeParse(field).success).toBe(true);
    }
  });

  test("accepts arbitrary nonempty metadata keys", () => {
    for (const field of [
      "meta.$thread",
      "meta.build-id",
      "meta.some.key",
      "meta.1",
      "meta.日本語",
    ]) {
      expect(selectFieldSpecSchema.safeParse(field).success).toBe(true);
    }
    expect(selectFieldSpecSchema.safeParse("meta.").success).toBe(false);
  });

  test("rejects empty selections, invalid fields, and unsafe bounds", () => {
    expect(selectSchema.safeParse([]).success).toBe(false);
    for (const field of [
      "created_at",
      "content:",
      "content:-1",
      "content:1:two",
      `content:${Number.MAX_SAFE_INTEGER + 1}`,
      `content:0:${Number.MAX_SAFE_INTEGER + 1}`,
      "unknown",
    ]) {
      expect(selectFieldSpecSchema.safeParse(field).success).toBe(false);
    }
  });

  test("reports concise validation errors", () => {
    expect(() => parseSelectFields([])).toThrow("Select at least one field");
    expect(() => parseSelectFields(["unknown"])).toThrow(
      "Invalid select field",
    );
  });

  test("allows exact duplicates but rejects distinct content slices", () => {
    expect(selectSchema.safeParse(["content:2:5", "content:2:5"]).success).toBe(
      true,
    );
    expect(selectSchema.safeParse(["content:2:5", "content:5:"]).success).toBe(
      false,
    );
    expect(
      selectSchema.safeParse(["content:200", "content:0:200"]).success,
    ).toBe(false);
  });
});

describe("projectMemory", () => {
  test("returns exactly requested bare fields and preserves any score", () => {
    expect(
      projectMemory(memory, parseSelectFields(["id", "tree", "score"])),
    ).toEqual({ id: memory.id, tree: memory.tree, score: 2.5 });
  });

  test("implements every content slice form in UTF-16 code units", () => {
    expect(projectMemory(memory, parseSelectFields(["content:4"]))).toEqual({
      content: "ab😀",
      contentLength: 12,
    });
    expect(projectMemory(memory, parseSelectFields(["content:4:7"]))).toEqual({
      content: "cde",
      contentLength: 12,
    });
    expect(projectMemory(memory, parseSelectFields(["content:10:"]))).toEqual({
      content: "ij",
      contentLength: 12,
    });
  });

  test("uses JavaScript slice semantics for reversed and out-of-range bounds", () => {
    expect(projectMemory(memory, parseSelectFields(["content:10:4"]))).toEqual({
      content: "",
      contentLength: 12,
    });
    expect(projectMemory(memory, parseSelectFields(["content:99:"]))).toEqual({
      content: "",
      contentLength: 12,
    });
  });

  test("a slice takes precedence over full content", () => {
    expect(
      projectMemory(memory, parseSelectFields(["content", "content:4"])),
    ).toEqual({ content: "ab😀", contentLength: 12 });
  });

  test("combines arbitrary metadata keys and omits missing keys", () => {
    expect(
      projectMemory(
        memory,
        parseSelectFields([
          "meta.$thread",
          "meta.build-id",
          "meta.some.key",
          "meta.missing",
        ]),
      ),
    ).toEqual({
      meta: { $thread: "thread-1", "build-id": 42, "some.key": true },
    });
  });

  test("full metadata takes precedence over metadata keys", () => {
    expect(
      projectMemory(memory, parseSelectFields(["meta.source", "meta"])),
    ).toEqual({ meta: memory.meta });
  });

  test("omits score when projecting a get response", () => {
    const { score: _score, ...getMemory } = memory;
    expect(projectMemory(getMemory, parseSelectFields(["score"]))).toEqual({});
  });

  test("projects search rows while preserving the result envelope", () => {
    expect(
      projectSearchResult(
        { results: [memory], total: 1, limit: 10 },
        parseSelectFields(["id", "score"]),
      ),
    ).toEqual({
      results: [{ id: memory.id, score: 2.5 }],
      total: 1,
      limit: 10,
    });
  });
});
