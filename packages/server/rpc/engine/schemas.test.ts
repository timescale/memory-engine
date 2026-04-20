/**
 * Tests for Engine RPC schemas.
 */
import { describe, expect, test } from "bun:test";
import {
  apiKeyCreateSchema,
  apiKeyDeleteSchema,
  apiKeyGetSchema,
  apiKeyListSchema,
  apiKeyRevokeSchema,
  grantCheckSchema,
  grantCreateSchema,
  grantListSchema,
  grantRevokeSchema,
  memoryBatchCreateSchema,
  memoryCreateSchema,
  memoryDeleteSchema,
  memoryDeleteTreeSchema,
  memoryGetSchema,
  memoryMoveSchema,
  memorySearchSchema,
  memoryTreeSchema,
  memoryUpdateSchema,
  ownerGetSchema,
  ownerListSchema,
  ownerRemoveSchema,
  ownerSetSchema,
  roleAddMemberSchema,
  roleCreateSchema,
  roleListForUserSchema,
  roleListMembersSchema,
  roleRemoveMemberSchema,
  treePathSchema,
  userCreateSchema,
  userGetSchema,
  userListSchema,
  userRenameSchema,
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

  test("accepts dryRun flag", () => {
    const result = memoryMoveSchema.safeParse({
      source: "old.path",
      destination: "new.path",
      dryRun: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dryRun).toBe(true);
    }
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

// =============================================================================
// User Schema Tests
// =============================================================================

describe("userCreateSchema", () => {
  test("accepts minimal params", () => {
    const result = userCreateSchema.safeParse({
      name: "alice",
    });
    expect(result.success).toBe(true);
  });

  test("accepts full params", () => {
    const result = userCreateSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
      name: "alice",
      identityId: "019d694f-79f6-7595-8faf-b70b01c11f99",
      canLogin: true,
      superuser: false,
      createrole: true,
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty name", () => {
    const result = userCreateSchema.safeParse({
      name: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("userGetSchema", () => {
  test("accepts valid UUID", () => {
    const result = userGetSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });
});

describe("userListSchema", () => {
  test("accepts empty params", () => {
    const result = userListSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("accepts canLogin filter", () => {
    const result = userListSchema.safeParse({
      canLogin: false,
    });
    expect(result.success).toBe(true);
  });
});

describe("userRenameSchema", () => {
  test("accepts valid params", () => {
    const result = userRenameSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
      name: "new-name",
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty name", () => {
    const result = userRenameSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
      name: "",
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Grant Schema Tests
// =============================================================================

describe("grantCreateSchema", () => {
  test("accepts valid params", () => {
    const result = grantCreateSchema.safeParse({
      userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      treePath: "work.projects",
      actions: ["read", "write"],
    });
    expect(result.success).toBe(true);
  });

  test("accepts with grant option", () => {
    const result = grantCreateSchema.safeParse({
      userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      treePath: "work",
      actions: ["admin"],
      withGrantOption: true,
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty actions", () => {
    const result = grantCreateSchema.safeParse({
      userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      treePath: "work",
      actions: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid action", () => {
    const result = grantCreateSchema.safeParse({
      userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      treePath: "work",
      actions: ["read", "invalid"],
    });
    expect(result.success).toBe(false);
  });
});

describe("grantListSchema", () => {
  test("accepts empty params", () => {
    const result = grantListSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("accepts userId filter", () => {
    const result = grantListSchema.safeParse({
      userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });
});

describe("grantRevokeSchema", () => {
  test("accepts valid params", () => {
    const result = grantRevokeSchema.safeParse({
      userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      treePath: "work.projects",
    });
    expect(result.success).toBe(true);
  });
});

describe("grantCheckSchema", () => {
  test("accepts valid params", () => {
    const result = grantCheckSchema.safeParse({
      userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      treePath: "work.projects.api",
      action: "read",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid action", () => {
    const result = grantCheckSchema.safeParse({
      userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      treePath: "work",
      action: "execute",
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Role Schema Tests
// =============================================================================

describe("roleCreateSchema", () => {
  test("accepts minimal params", () => {
    const result = roleCreateSchema.safeParse({
      name: "editors",
    });
    expect(result.success).toBe(true);
  });

  test("accepts with identityId", () => {
    const result = roleCreateSchema.safeParse({
      name: "editors",
      identityId: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty name", () => {
    const result = roleCreateSchema.safeParse({
      name: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("roleAddMemberSchema", () => {
  test("accepts valid params", () => {
    const result = roleAddMemberSchema.safeParse({
      roleId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      memberId: "019d694f-79f6-7595-8faf-b70b01c11f99",
    });
    expect(result.success).toBe(true);
  });

  test("accepts with admin option", () => {
    const result = roleAddMemberSchema.safeParse({
      roleId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      memberId: "019d694f-79f6-7595-8faf-b70b01c11f99",
      withAdminOption: true,
    });
    expect(result.success).toBe(true);
  });
});

describe("roleRemoveMemberSchema", () => {
  test("accepts valid params", () => {
    const result = roleRemoveMemberSchema.safeParse({
      roleId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      memberId: "019d694f-79f6-7595-8faf-b70b01c11f99",
    });
    expect(result.success).toBe(true);
  });
});

describe("roleListMembersSchema", () => {
  test("accepts valid params", () => {
    const result = roleListMembersSchema.safeParse({
      roleId: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });
});

describe("roleListForUserSchema", () => {
  test("accepts valid params", () => {
    const result = roleListForUserSchema.safeParse({
      userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// API Key Schema Tests
// =============================================================================

describe("apiKeyCreateSchema", () => {
  test("accepts minimal params", () => {
    const result = apiKeyCreateSchema.safeParse({
      userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      name: "my-api-key",
    });
    expect(result.success).toBe(true);
  });

  test("accepts with expiration", () => {
    const result = apiKeyCreateSchema.safeParse({
      userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      name: "my-api-key",
      expiresAt: "2025-12-31T23:59:59Z",
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty name", () => {
    const result = apiKeyCreateSchema.safeParse({
      userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      name: "",
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid expiration timestamp", () => {
    const result = apiKeyCreateSchema.safeParse({
      userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      name: "my-api-key",
      expiresAt: "not-a-timestamp",
    });
    expect(result.success).toBe(false);
  });
});

describe("apiKeyGetSchema", () => {
  test("accepts valid UUID", () => {
    const result = apiKeyGetSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });
});

describe("apiKeyListSchema", () => {
  test("accepts valid userId", () => {
    const result = apiKeyListSchema.safeParse({
      userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });
});

describe("apiKeyRevokeSchema", () => {
  test("accepts valid UUID", () => {
    const result = apiKeyRevokeSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });
});

describe("apiKeyDeleteSchema", () => {
  test("accepts valid UUID", () => {
    const result = apiKeyDeleteSchema.safeParse({
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Owner Schema Tests
// =============================================================================

describe("ownerSetSchema", () => {
  test("accepts valid params", () => {
    const result = ownerSetSchema.safeParse({
      userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
      treePath: "work.projects",
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing userId", () => {
    const result = ownerSetSchema.safeParse({
      treePath: "work.projects",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing treePath", () => {
    const result = ownerSetSchema.safeParse({
      userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid UUID", () => {
    const result = ownerSetSchema.safeParse({
      userId: "not-a-uuid",
      treePath: "work.projects",
    });
    expect(result.success).toBe(false);
  });
});

describe("ownerGetSchema", () => {
  test("accepts valid treePath", () => {
    const result = ownerGetSchema.safeParse({
      treePath: "work.projects.alpha",
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing treePath", () => {
    const result = ownerGetSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("ownerRemoveSchema", () => {
  test("accepts valid treePath", () => {
    const result = ownerRemoveSchema.safeParse({
      treePath: "work.projects",
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing treePath", () => {
    const result = ownerRemoveSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("ownerListSchema", () => {
  test("accepts with userId", () => {
    const result = ownerListSchema.safeParse({
      userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
    });
    expect(result.success).toBe(true);
  });

  test("accepts without userId", () => {
    const result = ownerListSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("rejects invalid userId", () => {
    const result = ownerListSchema.safeParse({
      userId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });
});
