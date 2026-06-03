/**
 * Unit tests for identity/me RPC handlers.
 *
 * Uses a mocked AuthStore to test handler logic in isolation.
 */
import { describe, expect, mock, test } from "bun:test";
import type { User } from "@memory.build/auth";
import type { HandlerContext } from "../types";
import { meMethods } from "./me";

const authUser: User = {
  id: "019d694f-79f6-7595-8faf-b70b01c11f98",
  email: "alice@example.com",
  name: "Alice",
  emailVerified: true,
  image: null,
  createdAt: new Date("2026-01-15T00:00:00.000Z"),
  updatedAt: null,
};

function createMockContext(
  authOverrides: Record<string, unknown> = {},
): HandlerContext {
  return {
    request: new Request("http://localhost"),
    // Legacy AccountsDB stub — present only to satisfy the context guard.
    db: {},
    auth: {
      getUser: mock(() => Promise.resolve(authUser)),
      getUserByEmail: mock(() => Promise.resolve(null)),
      ...authOverrides,
    },
    identity: {
      id: authUser.id,
      email: authUser.email,
      name: authUser.name,
    },
    engineSql: mock(() => {}) as unknown,
    serverVersion: "0.1.1",
  } as unknown as HandlerContext;
}

// =============================================================================
// me.get
// =============================================================================

describe("me.get", () => {
  test("returns the authenticated user", async () => {
    const handler = meMethods.get("me.get")?.handler;
    if (!handler) throw new Error("me.get handler not found");

    const context = createMockContext();
    const result = (await handler({}, context)) as {
      id: string;
      email: string;
      name: string;
    };

    expect(result.id).toBe(authUser.id);
    expect(result.email).toBe("alice@example.com");
    expect(result.name).toBe("Alice");
  });

  test("looks up the user by the session identity id", async () => {
    const handler = meMethods.get("me.get")?.handler;
    if (!handler) throw new Error("me.get handler not found");

    const getUser = mock(() => Promise.resolve(authUser));
    const context = createMockContext({ getUser });

    await handler({}, context);

    expect(getUser).toHaveBeenCalledWith(authUser.id);
  });
});

// =============================================================================
// identity.getByEmail
// =============================================================================

describe("identity.getByEmail", () => {
  test("returns identity when found", async () => {
    const handler = meMethods.get("identity.getByEmail")?.handler;
    if (!handler) throw new Error("identity.getByEmail handler not found");

    const bob: User = {
      id: "019d694f-79f6-7595-8faf-b70b01c11f99",
      email: "bob@example.com",
      name: "Bob",
      emailVerified: true,
      image: null,
      createdAt: new Date("2026-01-15T00:00:00.000Z"),
      updatedAt: null,
    };

    const context = createMockContext({
      getUserByEmail: mock(() => Promise.resolve(bob)),
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
      getUserByEmail: mock(() => Promise.resolve(null)),
    });

    const result = (await handler(
      { email: "nobody@example.com" },
      context,
    )) as { identity: null };

    expect(result.identity).toBeNull();
  });

  test("passes email to the auth-store lookup", async () => {
    const handler = meMethods.get("identity.getByEmail")?.handler;
    if (!handler) throw new Error("identity.getByEmail handler not found");

    const getUserByEmail = mock(() => Promise.resolve(null));
    const context = createMockContext({ getUserByEmail });

    await handler({ email: "test@example.com" }, context);

    expect(getUserByEmail).toHaveBeenCalledWith("test@example.com");
  });
});
