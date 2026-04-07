/**
 * Tests for Engine RPC schemas.
 */
import { describe, expect, test } from "bun:test";
import {
  memoryBatchCreateSchema,
  memoryCreateSchema,
  memoryDeleteSchema,
  memoryDeleteTreeSchema,
  memoryGetSchema,
  memoryMoveSchema,
  memorySearchSchema,
  memoryTreeSchema,
  memoryUpdateSchema,
  treePathSchema,
  uuidv7Schema,
} from "./schemas";

describe("uuidv7Schema", () => {
  test("accepts valid UUIDv7", () => {
    const validUuids = [
      "019d694f-79f6-7595-8faf-b70b01c11f98",
      "019d694f-79f6-7595-9faf-b70b01c11f98",
      "019d694f-79f6-7595-afaf-b70b01c11f98",
      "019d694f-79f6-7595-bfaf-b70b01c11f98",
    ];
    for (const uuid of validUuids) {
      expect(uuidv7Schema.safeParse(uuid).success).toBe(true);
    }
  });

  test("rejects invalid UUIDs", () => {
    const invalidUuids = [
      "not-a-uuid",
      "019d694f-79f6-4595-8faf-b70b01c11f98", // v4 not v7
      "019d694f-79f6-7595-0faf-b70b01c11f98", // invalid variant
      "019d694f79f675958fafb70b01c11f98", // no dashes
      "",
    ];
    for (const uuid of invalidUuids) {
      expect(uuidv7Schema.safeParse(uuid).success).toBe(false);
    }
  });
});

describe("treePathSchema", () => {
  test("accepts valid tree paths", () => {
    const validPaths = [
      "", // root
      "work",
      "work.projects",
      "work.projects.api",
      "me_design",
      "A1_B2_C3",
    ];
    for (const path of validPaths) {
      expect(treePathSchema.safeParse(path).success).toBe(true);
    }
  });

  test("rejects invalid tree paths", () => {
    const invalidPaths = [
      "work.projects.", // trailing dot
      ".work.projects", // leading dot
      "work..projects", // double dot
      "work-projects", // hyphen not allowed
      "work projects", // space not allowed
    ];
    for (const path of invalidPaths) {
      expect(treePathSchema.safeParse(path).success).toBe(false);
    }
  });
});

describe("memoryCreateSchema", () => {
  test("accepts minimal params", () => {
    const result = memoryCreateSchema.safeParse({
      content: "Hello world",
    });
    expect(result.success).toBe(true);
  });

  test("accepts full params", () => {
    const result = memoryCreateSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
      content: "Hello world",
      meta: { type: "note", tags: ["test"] },
      tree: "work.notes",
      temporal: {
        start: "2024-01-01T00:00:00Z",
        end: "2024-01-02T00:00:00Z",
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts point-in-time temporal", () => {
    const result = memoryCreateSchema.safeParse({
      content: "Hello world",
      temporal: {
        start: "2024-01-01T00:00:00Z",
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty content", () => {
    const result = memoryCreateSchema.safeParse({
      content: "",
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid tree path", () => {
    const result = memoryCreateSchema.safeParse({
      content: "Hello",
      tree: "invalid-path",
    });
    expect(result.success).toBe(false);
  });
});

describe("memoryBatchCreateSchema", () => {
  test("accepts array of memories", () => {
    const result = memoryBatchCreateSchema.safeParse({
      memories: [
        { content: "Memory 1" },
        { content: "Memory 2", tree: "work" },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty array", () => {
    const result = memoryBatchCreateSchema.safeParse({
      memories: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects more than 1000 memories", () => {
    const memories = Array(1001)
      .fill(null)
      .map((_, i) => ({ content: `Memory ${i}` }));
    const result = memoryBatchCreateSchema.safeParse({ memories });
    expect(result.success).toBe(false);
  });
});

describe("memoryGetSchema", () => {
  test("accepts valid UUID", () => {
    const result = memoryGetSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid UUID", () => {
    const result = memoryGetSchema.safeParse({
      id: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });
});

describe("memoryUpdateSchema", () => {
  test("accepts id with no updates (no-op)", () => {
    const result = memoryUpdateSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });

  test("accepts partial updates", () => {
    const result = memoryUpdateSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
      content: "Updated content",
    });
    expect(result.success).toBe(true);
  });

  test("accepts null to clear optional fields", () => {
    const result = memoryUpdateSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
      temporal: null,
    });
    expect(result.success).toBe(true);
  });
});

describe("memoryDeleteSchema", () => {
  test("accepts valid UUID", () => {
    const result = memoryDeleteSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });
});

describe("memorySearchSchema", () => {
  test("accepts empty params (filter-only)", () => {
    const result = memorySearchSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("accepts fulltext search", () => {
    const result = memorySearchSchema.safeParse({
      fulltext: "hello world",
    });
    expect(result.success).toBe(true);
  });

  test("accepts semantic search", () => {
    const result = memorySearchSchema.safeParse({
      semantic: "What is the meaning of life?",
    });
    expect(result.success).toBe(true);
  });

  test("accepts hybrid search", () => {
    const result = memorySearchSchema.safeParse({
      semantic: "meaning of life",
      fulltext: "philosophy",
    });
    expect(result.success).toBe(true);
  });

  test("accepts tree filter with lquery pattern", () => {
    const result = memorySearchSchema.safeParse({
      tree: "work.*",
    });
    expect(result.success).toBe(true);
  });

  test("accepts tree filter with ltxtquery", () => {
    const result = memorySearchSchema.safeParse({
      tree: "api & v2",
    });
    expect(result.success).toBe(true);
  });

  test("accepts temporal contains filter", () => {
    const result = memorySearchSchema.safeParse({
      temporal: {
        contains: "2024-01-15T12:00:00Z",
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts temporal overlaps filter", () => {
    const result = memorySearchSchema.safeParse({
      temporal: {
        overlaps: {
          start: "2024-01-01T00:00:00Z",
          end: "2024-01-31T23:59:59Z",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts temporal within filter", () => {
    const result = memorySearchSchema.safeParse({
      temporal: {
        within: {
          start: "2024-01-01T00:00:00Z",
          end: "2024-12-31T23:59:59Z",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts search weights", () => {
    const result = memorySearchSchema.safeParse({
      semantic: "test",
      fulltext: "test",
      weights: {
        semantic: 0.7,
        fulltext: 0.3,
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid limit", () => {
    const result = memorySearchSchema.safeParse({
      limit: 0,
    });
    expect(result.success).toBe(false);
  });

  test("rejects limit over 1000", () => {
    const result = memorySearchSchema.safeParse({
      limit: 1001,
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid weights", () => {
    const result = memorySearchSchema.safeParse({
      weights: {
        semantic: 1.5, // > 1
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("memoryTreeSchema", () => {
  test("accepts empty params", () => {
    const result = memoryTreeSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("accepts tree path", () => {
    const result = memoryTreeSchema.safeParse({
      tree: "work.projects",
    });
    expect(result.success).toBe(true);
  });

  test("accepts levels", () => {
    const result = memoryTreeSchema.safeParse({
      levels: 3,
    });
    expect(result.success).toBe(true);
  });

  test("rejects levels over 100", () => {
    const result = memoryTreeSchema.safeParse({
      levels: 101,
    });
    expect(result.success).toBe(false);
  });
});

describe("memoryMoveSchema", () => {
  test("accepts valid source and destination", () => {
    const result = memoryMoveSchema.safeParse({
      source: "old.path",
      destination: "new.path",
    });
    expect(result.success).toBe(true);
  });

  test("accepts moving to root", () => {
    const result = memoryMoveSchema.safeParse({
      source: "old.path",
      destination: "",
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty source", () => {
    const result = memoryMoveSchema.safeParse({
      source: "",
      destination: "new.path",
    });
    expect(result.success).toBe(false);
  });
});

describe("memoryDeleteTreeSchema", () => {
  test("accepts valid tree path", () => {
    const result = memoryDeleteTreeSchema.safeParse({
      tree: "old.stuff",
    });
    expect(result.success).toBe(true);
  });

  test("accepts dryRun flag", () => {
    const result = memoryDeleteTreeSchema.safeParse({
      tree: "old.stuff",
      dryRun: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dryRun).toBe(true);
    }
  });

  test("rejects empty tree path", () => {
    const result = memoryDeleteTreeSchema.safeParse({
      tree: "",
    });
    expect(result.success).toBe(false);
  });
});
