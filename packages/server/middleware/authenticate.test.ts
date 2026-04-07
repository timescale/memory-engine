import { describe, expect, test, mock } from "bun:test";
import {
  authenticateAccounts,
  extractBearerToken,
  type Identity,
} from "./authenticate";

describe("extractBearerToken", () => {
  test("extracts token from valid Authorization header", () => {
    const request = new Request("http://localhost/test", {
      headers: { Authorization: "Bearer abc123" },
    });
    expect(extractBearerToken(request)).toBe("abc123");
  });

  test("returns null for missing Authorization header", () => {
    const request = new Request("http://localhost/test");
    expect(extractBearerToken(request)).toBeNull();
  });

  test("returns null for non-Bearer Authorization", () => {
    const request = new Request("http://localhost/test", {
      headers: { Authorization: "Basic abc123" },
    });
    expect(extractBearerToken(request)).toBeNull();
  });

  test("returns null for malformed Bearer header", () => {
    const request = new Request("http://localhost/test", {
      headers: { Authorization: "Bearer" },
    });
    expect(extractBearerToken(request)).toBeNull();
  });
});

describe("authenticateAccounts", () => {
  const mockIdentity: Identity = {
    id: "identity-123",
    email: "test@example.com",
    name: "Test User",
  };

  test("returns 401 when no Authorization header", async () => {
    const request = new Request("http://localhost/test");
    const mockDb = { validateSession: mock(() => Promise.resolve(null)) };

    const result = await authenticateAccounts(request, mockDb as any);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(401);
    }
  });

  test("returns 401 when session validation fails", async () => {
    const request = new Request("http://localhost/test", {
      headers: { Authorization: "Bearer invalid-token" },
    });
    const mockDb = { validateSession: mock(() => Promise.resolve(null)) };

    const result = await authenticateAccounts(request, mockDb as any);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(401);
    }
    expect(mockDb.validateSession).toHaveBeenCalledWith("invalid-token");
  });

  test("returns identity when session is valid", async () => {
    const request = new Request("http://localhost/test", {
      headers: { Authorization: "Bearer valid-token" },
    });
    const mockDb = {
      validateSession: mock(() =>
        Promise.resolve({
          session: { id: "session-1", identityId: mockIdentity.id },
          identity: mockIdentity,
        }),
      ),
    };

    const result = await authenticateAccounts(request, mockDb as any);

    expect(result.ok).toBe(true);
    if (result.ok && result.context.type === "accounts") {
      expect(result.context.identity).toEqual(mockIdentity);
    }
  });
});
