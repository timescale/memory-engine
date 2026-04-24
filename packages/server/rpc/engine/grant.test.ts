/**
 * Unit tests for grant RPC handlers.
 *
 * Uses mocked EngineDB to test handler logic in isolation.
 * Verifies that responses include userName from JOINed user data.
 */
import { describe, expect, mock, test } from "bun:test";
import type { HandlerContext } from "../types";
import { grantMethods } from "./grant";

const TEST_UUID = "019d694f-79f6-7595-8faf-b70b01c11f98";
const TEST_UUID_2 = "019d694f-79f6-7595-8faf-b70b01c11f99";

function createMockContext(
  dbOverrides: Record<string, unknown> = {},
): HandlerContext {
  return {
    request: new Request("http://localhost"),
    db: {
      grantTreeAccess: mock(() => Promise.resolve()),
      revokeTreeAccess: mock(() => Promise.resolve(false)),
      listTreeGrants: mock(() => Promise.resolve([])),
      getTreeGrant: mock(() => Promise.resolve(null)),
      checkTreeAccess: mock(() => Promise.resolve(false)),
      ...dbOverrides,
    },
    userId: "user-123",
    apiKeyId: "key-456",
    engine: {
      id: "eng-1",
      orgId: "org-1",
      slug: "test",
      name: "Test",
      status: "active" as const,
    },
  } as unknown as HandlerContext;
}

// =============================================================================
// grant.create
// =============================================================================

describe("grant.create", () => {
  test("calls grantTreeAccess and returns { created: true }", async () => {
    const handler = grantMethods.get("grant.create")?.handler;
    if (!handler) throw new Error("grant.create handler not found");

    const grantTreeAccess = mock(() => Promise.resolve());
    const context = createMockContext({ grantTreeAccess });

    const result = await handler(
      {
        userId: TEST_UUID,
        treePath: "work.projects",
        actions: ["read", "create"],
        withGrantOption: false,
      },
      context,
    );

    expect(result).toEqual({ created: true });
    expect(grantTreeAccess).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// grant.list
// =============================================================================

describe("grant.list", () => {
  test("returns grants with userName", async () => {
    const handler = grantMethods.get("grant.list")?.handler;
    if (!handler) throw new Error("grant.list handler not found");

    const now = new Date("2026-01-15T00:00:00.000Z");
    const listTreeGrants = mock(() =>
      Promise.resolve([
        {
          id: TEST_UUID_2,
          userId: TEST_UUID,
          userName: "alice",
          treePath: "work.projects",
          actions: ["read"],
          grantedBy: null,
          withGrantOption: false,
          createdAt: now,
        },
      ]),
    );
    const context = createMockContext({ listTreeGrants });

    const result = (await handler({}, context)) as {
      grants: Array<{
        userId: string;
        userName: string;
        treePath: string;
      }>;
    };

    expect(result.grants).toHaveLength(1);
    expect(result.grants[0]?.userName).toBe("alice");
    expect(result.grants[0]?.userId).toBe(TEST_UUID);
    expect(result.grants[0]?.treePath).toBe("work.projects");
  });

  test("returns empty list when no grants", async () => {
    const handler = grantMethods.get("grant.list")?.handler;
    if (!handler) throw new Error("grant.list handler not found");

    const context = createMockContext();

    const result = (await handler({}, context)) as {
      grants: unknown[];
    };

    expect(result.grants).toHaveLength(0);
  });

  test("passes userId filter when provided", async () => {
    const handler = grantMethods.get("grant.list")?.handler;
    if (!handler) throw new Error("grant.list handler not found");

    const listTreeGrants = mock(() => Promise.resolve([]));
    const context = createMockContext({ listTreeGrants });

    await handler({ userId: TEST_UUID }, context);

    expect(listTreeGrants).toHaveBeenCalledWith(TEST_UUID);
  });
});

// =============================================================================
// grant.get
// =============================================================================

describe("grant.get", () => {
  test("returns grant with userName when found", async () => {
    const handler = grantMethods.get("grant.get")?.handler;
    if (!handler) throw new Error("grant.get handler not found");

    const now = new Date("2026-01-15T00:00:00.000Z");
    const getTreeGrant = mock(() =>
      Promise.resolve({
        id: TEST_UUID_2,
        userId: TEST_UUID,
        userName: "alice",
        treePath: "work",
        actions: ["read", "create"],
        grantedBy: null,
        withGrantOption: true,
        createdAt: now,
      }),
    );
    const context = createMockContext({ getTreeGrant });

    const result = (await handler(
      { userId: TEST_UUID, treePath: "work" },
      context,
    )) as { userName: string; withGrantOption: boolean };

    expect(result.userName).toBe("alice");
    expect(result.withGrantOption).toBe(true);
  });

  test("throws NOT_FOUND when grant does not exist", async () => {
    const handler = grantMethods.get("grant.get")?.handler;
    if (!handler) throw new Error("grant.get handler not found");

    const context = createMockContext({
      getTreeGrant: mock(() => Promise.resolve(null)),
    });

    try {
      await handler({ userId: TEST_UUID, treePath: "work" }, context);
      throw new Error("Expected handler to throw");
    } catch (error) {
      expect((error as { code: string }).code).toBe("NOT_FOUND");
    }
  });
});

// =============================================================================
// grant.revoke
// =============================================================================

describe("grant.revoke", () => {
  test("returns { revoked: true } when found", async () => {
    const handler = grantMethods.get("grant.revoke")?.handler;
    if (!handler) throw new Error("grant.revoke handler not found");

    const context = createMockContext({
      revokeTreeAccess: mock(() => Promise.resolve(true)),
    });

    const result = await handler(
      { userId: TEST_UUID, treePath: "work" },
      context,
    );
    expect(result).toEqual({ revoked: true });
  });

  test("throws NOT_FOUND when grant does not exist", async () => {
    const handler = grantMethods.get("grant.revoke")?.handler;
    if (!handler) throw new Error("grant.revoke handler not found");

    const context = createMockContext({
      revokeTreeAccess: mock(() => Promise.resolve(false)),
    });

    try {
      await handler({ userId: TEST_UUID, treePath: "work" }, context);
      throw new Error("Expected handler to throw");
    } catch (error) {
      expect((error as { code: string }).code).toBe("NOT_FOUND");
    }
  });
});

// =============================================================================
// grant.check
// =============================================================================

describe("grant.check", () => {
  test("returns { allowed: true } when access granted", async () => {
    const handler = grantMethods.get("grant.check")?.handler;
    if (!handler) throw new Error("grant.check handler not found");

    const context = createMockContext({
      checkTreeAccess: mock(() => Promise.resolve(true)),
    });

    const result = await handler(
      { userId: TEST_UUID, treePath: "work", action: "read" },
      context,
    );
    expect(result).toEqual({ allowed: true });
  });

  test("returns { allowed: false } when access denied", async () => {
    const handler = grantMethods.get("grant.check")?.handler;
    if (!handler) throw new Error("grant.check handler not found");

    const context = createMockContext({
      checkTreeAccess: mock(() => Promise.resolve(false)),
    });

    const result = await handler(
      { userId: TEST_UUID, treePath: "work", action: "update" },
      context,
    );
    expect(result).toEqual({ allowed: false });
  });
});
