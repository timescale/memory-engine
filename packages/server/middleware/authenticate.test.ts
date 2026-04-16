import { describe, expect, mock, test } from "bun:test";
import type { AccountsDB } from "@memory.build/accounts";
import type { EngineDB } from "@memory.build/engine";
import type { SQL } from "bun";
import {
  authenticateAccounts,
  authenticateEngine,
  type CreateEngineDBFn,
  type EngineInfo,
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
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: null,
  };

  test("returns 401 when no Authorization header", async () => {
    const request = new Request("http://localhost/test");
    const mockDb = {
      validateSession: mock(() => Promise.resolve(null)),
    } as unknown as AccountsDB;

    const result = await authenticateAccounts(request, mockDb);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(401);
    }
  });

  test("returns 401 when session validation fails", async () => {
    const request = new Request("http://localhost/test", {
      headers: { Authorization: "Bearer invalid-token" },
    });
    const validateSession = mock(() => Promise.resolve(null));
    const mockDb = { validateSession } as unknown as AccountsDB;

    const result = await authenticateAccounts(request, mockDb);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(401);
    }
    expect(validateSession).toHaveBeenCalledWith("invalid-token");
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
    } as unknown as AccountsDB;

    const result = await authenticateAccounts(request, mockDb);

    expect(result.ok).toBe(true);
    if (result.ok && result.context.type === "accounts") {
      expect(result.context.identity).toEqual(mockIdentity);
    }
  });
});

describe("authenticateEngine", () => {
  const mockEngine: EngineInfo = {
    id: "engine-123",
    orgId: "org-456",
    slug: "abc123xyz789",
    name: "Test Engine",
    status: "active",
  };

  const createMockAccountsDb = (engine: EngineInfo | null) =>
    ({
      getEngineBySlug: mock(() => Promise.resolve(engine)),
    }) as unknown as AccountsDB;

  const createMockEngineDb = (validationResult: {
    valid: boolean;
    userId?: string;
    apiKeyId?: string;
  }) =>
    ({
      validateApiKey: mock(() => Promise.resolve(validationResult)),
      setUser: mock(() => {}),
    }) as unknown as EngineDB;

  const mockCreateEngineDB = mock((_sql: SQL, _schema: string) => {
    return createMockEngineDb({
      valid: true,
      userId: "user-789",
      apiKeyId: "apikey-abc",
    });
  }) as unknown as CreateEngineDBFn;

  // Valid API key format: me.{slug}.{lookupId}.{secret}
  // Secret must be exactly 32 chars (base64url)
  const validApiKey =
    "me.abc123xyz789.Sh00uLs5rmSHHun3.pREy3xfnbCpgUXiaBcDefghij1234567";

  test("returns 401 when no Authorization header", async () => {
    const request = new Request("http://localhost/test");
    const mockAccountsDb = createMockAccountsDb(mockEngine);

    const result = await authenticateEngine(
      request,
      mockAccountsDb,
      {} as SQL,
      mockCreateEngineDB,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(401);
    }
  });

  test("returns 401 when API key format is invalid", async () => {
    const request = new Request("http://localhost/test", {
      headers: { Authorization: "Bearer invalid-format" },
    });
    const mockAccountsDb = createMockAccountsDb(mockEngine);

    const result = await authenticateEngine(
      request,
      mockAccountsDb,
      {} as SQL,
      mockCreateEngineDB,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(401);
    }
  });

  test("returns 401 when engine not found", async () => {
    const request = new Request("http://localhost/test", {
      headers: { Authorization: `Bearer ${validApiKey}` },
    });
    const mockAccountsDb = createMockAccountsDb(null);

    const result = await authenticateEngine(
      request,
      mockAccountsDb,
      {} as SQL,
      mockCreateEngineDB,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(401);
    }
  });

  test("returns 403 when engine is suspended", async () => {
    const request = new Request("http://localhost/test", {
      headers: { Authorization: `Bearer ${validApiKey}` },
    });
    const suspendedEngine = { ...mockEngine, status: "suspended" as const };
    const mockAccountsDb = createMockAccountsDb(suspendedEngine);

    const result = await authenticateEngine(
      request,
      mockAccountsDb,
      {} as SQL,
      mockCreateEngineDB,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(403);
    }
  });

  test("returns 403 when engine is deleted", async () => {
    const request = new Request("http://localhost/test", {
      headers: { Authorization: `Bearer ${validApiKey}` },
    });
    const deletedEngine = { ...mockEngine, status: "deleted" as const };
    const mockAccountsDb = createMockAccountsDb(deletedEngine);

    const result = await authenticateEngine(
      request,
      mockAccountsDb,
      {} as SQL,
      mockCreateEngineDB,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(403);
    }
  });

  test("returns 401 when API key validation fails", async () => {
    const request = new Request("http://localhost/test", {
      headers: { Authorization: `Bearer ${validApiKey}` },
    });
    const mockAccountsDb = createMockAccountsDb(mockEngine);
    const mockCreateEngineDBInvalid = mock(() =>
      createMockEngineDb({ valid: false }),
    ) as unknown as CreateEngineDBFn;

    const result = await authenticateEngine(
      request,
      mockAccountsDb,
      {} as SQL,
      mockCreateEngineDBInvalid,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(401);
    }
  });

  test("returns engine context when authentication succeeds", async () => {
    const request = new Request("http://localhost/test", {
      headers: { Authorization: `Bearer ${validApiKey}` },
    });
    const mockAccountsDb = createMockAccountsDb(mockEngine);
    const mockEngineDb = createMockEngineDb({
      valid: true,
      userId: "user-789",
      apiKeyId: "apikey-abc",
    });
    const mockCreateEngineDBSuccess = mock(
      () => mockEngineDb,
    ) as unknown as CreateEngineDBFn;

    const result = await authenticateEngine(
      request,
      mockAccountsDb,
      {} as SQL,
      mockCreateEngineDBSuccess,
    );

    expect(result.ok).toBe(true);
    if (result.ok && result.context.type === "engine") {
      expect(result.context.db).toBe(mockEngineDb);
      expect(result.context.userId).toBe("user-789");
      expect(result.context.apiKeyId).toBe("apikey-abc");
      expect(result.context.engine).toEqual(mockEngine);
      expect(mockEngineDb.setUser).toHaveBeenCalledWith("user-789");
    }
  });
});
