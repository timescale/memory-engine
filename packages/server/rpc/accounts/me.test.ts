/**
 * Unit tests for identity/me RPC handlers.
 *
 * Uses mocked AccountsDB to test handler logic in isolation.
 */
import { describe, expect, mock, test } from "bun:test";
import type { HandlerContext } from "../types";
import { meMethods } from "./me";

function createMockContext(
  dbOverrides: Record<string, unknown> = {},
): HandlerContext {
  return {
    request: new Request("http://localhost"),
    db: {
      getIdentityByEmail: mock(() => Promise.resolve(null)),
      ...dbOverrides,
    },
    identity: {
      id: "019d694f-79f6-7595-8faf-b70b01c11f98",
      email: "alice@example.com",
      name: "Alice",
      createdAt: new Date("2026-01-15T00:00:00.000Z"),
      updatedAt: null,
    },
    engineSql: mock(() => {}) as unknown,
    appVersion: "0.1.1",
  } as unknown as HandlerContext;
}

// =============================================================================
// me.get
// =============================================================================

describe("me.get", () => {
  test("returns the authenticated identity", async () => {
    const handler = meMethods.get("me.get")?.handler;
    if (!handler) throw new Error("me.get handler not found");

    const context = createMockContext();
    const result = (await handler({}, context)) as {
      id: string;
      email: string;
      name: string;
    };

    expect(result.id).toBe("019d694f-79f6-7595-8faf-b70b01c11f98");
    expect(result.email).toBe("alice@example.com");
    expect(result.name).toBe("Alice");
  });
});

// =============================================================================
// identity.getByEmail
// =============================================================================

describe("identity.getByEmail", () => {
  test("returns identity when found", async () => {
    const handler = meMethods.get("identity.getByEmail")?.handler;
    if (!handler) throw new Error("identity.getByEmail handler not found");

    const identity = {
      id: "019d694f-79f6-7595-8faf-b70b01c11f99",
      email: "bob@example.com",
      name: "Bob",
      createdAt: new Date("2026-01-15T00:00:00.000Z"),
      updatedAt: null,
    };

    const context = createMockContext({
      getIdentityByEmail: mock(() => Promise.resolve(identity)),
    });

    const result = (await handler({ email: "bob@example.com" }, context)) as {
      identity: { id: string; email: string; name: string } | null;
    };

    expect(result.identity).not.toBeNull();
    expect(result.identity!.id).toBe("019d694f-79f6-7595-8faf-b70b01c11f99");
    expect(result.identity!.email).toBe("bob@example.com");
    expect(result.identity!.name).toBe("Bob");
  });

  test("returns null identity when not found", async () => {
    const handler = meMethods.get("identity.getByEmail")?.handler;
    if (!handler) throw new Error("identity.getByEmail handler not found");

    const context = createMockContext({
      getIdentityByEmail: mock(() => Promise.resolve(null)),
    });

    const result = (await handler(
      { email: "nobody@example.com" },
      context,
    )) as { identity: null };

    expect(result.identity).toBeNull();
  });

  test("passes email to db lookup", async () => {
    const handler = meMethods.get("identity.getByEmail")?.handler;
    if (!handler) throw new Error("identity.getByEmail handler not found");

    const getIdentityByEmail = mock(() => Promise.resolve(null));
    const context = createMockContext({ getIdentityByEmail });

    await handler({ email: "test@example.com" }, context);

    expect(getIdentityByEmail).toHaveBeenCalledWith("test@example.com");
  });
});
