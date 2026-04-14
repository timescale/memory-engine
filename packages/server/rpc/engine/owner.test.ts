/**
 * Unit tests for owner RPC handlers.
 *
 * Uses mocked EngineDB to test handler logic in isolation.
 */
import { describe, expect, mock, test } from "bun:test";
import type { HandlerContext } from "../types";
import { ownerMethods } from "./owner";

function createMockContext(
  dbOverrides: Record<string, unknown> = {},
): HandlerContext {
  return {
    request: new Request("http://localhost"),
    db: {
      getUserId: mock(() => "user-123"),
      setTreeOwner: mock(() => Promise.resolve()),
      getTreeOwner: mock(() => Promise.resolve(null)),
      removeTreeOwner: mock(() => Promise.resolve(false)),
      listTreeOwners: mock(() => Promise.resolve([])),
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

describe("owner.set", () => {
  test("calls setTreeOwner and returns { set: true }", async () => {
    const handler = ownerMethods.get("owner.set")?.handler;
    if (!handler) throw new Error("owner.set handler not found");

    const setTreeOwner = mock(() => Promise.resolve());
    const context = createMockContext({ setTreeOwner });

    const result = await handler(
      {
        userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
        treePath: "work.projects",
      },
      context,
    );

    expect(result).toEqual({ set: true });
    expect(setTreeOwner).toHaveBeenCalledTimes(1);
  });
});

describe("owner.get", () => {
  test("returns owner when found", async () => {
    const handler = ownerMethods.get("owner.get")?.handler;
    if (!handler) throw new Error("owner.get handler not found");

    const now = new Date("2026-01-15T00:00:00.000Z");
    const getTreeOwner = mock(() =>
      Promise.resolve({
        treePath: "work.projects",
        userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
        userName: "alice",
        createdBy: "user-123",
        createdByName: "admin",
        createdAt: now,
      }),
    );
    const context = createMockContext({ getTreeOwner });

    const result = (await handler({ treePath: "work.projects" }, context)) as {
      treePath: string;
      userId: string;
      userName: string;
      createdBy: string;
      createdByName: string;
      createdAt: string;
    };

    expect(result.treePath).toBe("work.projects");
    expect(result.userId).toBe("019d694f-79f6-7595-8faf-b70b01c11f98");
    expect(result.userName).toBe("alice");
    expect(result.createdBy).toBe("user-123");
    expect(result.createdByName).toBe("admin");
    expect(result.createdAt).toBe("2026-01-15T00:00:00.000Z");
  });

  test("throws NOT_FOUND when no owner", async () => {
    const handler = ownerMethods.get("owner.get")?.handler;
    if (!handler) throw new Error("owner.get handler not found");

    const context = createMockContext({
      getTreeOwner: mock(() => Promise.resolve(null)),
    });

    try {
      await handler({ treePath: "work.projects" }, context);
      throw new Error("Expected handler to throw");
    } catch (error) {
      expect((error as { code: string }).code).toBe("NOT_FOUND");
    }
  });
});

describe("owner.remove", () => {
  test("returns { removed: true } when found", async () => {
    const handler = ownerMethods.get("owner.remove")?.handler;
    if (!handler) throw new Error("owner.remove handler not found");

    const context = createMockContext({
      removeTreeOwner: mock(() => Promise.resolve(true)),
    });

    const result = await handler({ treePath: "work.projects" }, context);
    expect(result).toEqual({ removed: true });
  });

  test("throws NOT_FOUND when no owner to remove", async () => {
    const handler = ownerMethods.get("owner.remove")?.handler;
    if (!handler) throw new Error("owner.remove handler not found");

    const context = createMockContext({
      removeTreeOwner: mock(() => Promise.resolve(false)),
    });

    try {
      await handler({ treePath: "work.projects" }, context);
      throw new Error("Expected handler to throw");
    } catch (error) {
      expect((error as { code: string }).code).toBe("NOT_FOUND");
    }
  });
});

describe("owner.list", () => {
  test("returns owners list", async () => {
    const handler = ownerMethods.get("owner.list")?.handler;
    if (!handler) throw new Error("owner.list handler not found");

    const now = new Date("2026-01-15T00:00:00.000Z");
    const listTreeOwners = mock(() =>
      Promise.resolve([
        {
          treePath: "work.projects",
          userId: "019d694f-79f6-7595-8faf-b70b01c11f98",
          userName: "alice",
          createdBy: "user-123",
          createdByName: "admin",
          createdAt: now,
        },
      ]),
    );
    const context = createMockContext({ listTreeOwners });

    const result = (await handler({}, context)) as {
      owners: Array<{ treePath: string }>;
    };

    expect(result.owners).toHaveLength(1);
    expect(result.owners[0]?.treePath).toBe("work.projects");
  });

  test("returns empty list when no owners", async () => {
    const handler = ownerMethods.get("owner.list")?.handler;
    if (!handler) throw new Error("owner.list handler not found");

    const context = createMockContext({
      listTreeOwners: mock(() => Promise.resolve([])),
    });

    const result = (await handler({}, context)) as {
      owners: Array<{ treePath: string }>;
    };

    expect(result.owners).toHaveLength(0);
  });

  test("passes userId filter when provided", async () => {
    const handler = ownerMethods.get("owner.list")?.handler;
    if (!handler) throw new Error("owner.list handler not found");

    const listTreeOwners = mock(() => Promise.resolve([]));
    const context = createMockContext({ listTreeOwners });

    await handler({ userId: "019d694f-79f6-7595-8faf-b70b01c11f98" }, context);

    expect(listTreeOwners).toHaveBeenCalledWith(
      "019d694f-79f6-7595-8faf-b70b01c11f98",
    );
  });
});
