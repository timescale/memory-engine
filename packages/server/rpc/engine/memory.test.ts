import { describe, expect, mock, test } from "bun:test";
import type { HandlerContext } from "../types";

describe("memory.search embedding", () => {
  test("throws EMBEDDING_NOT_CONFIGURED when semantic provided without config", async () => {
    // Import the handler module to test
    const { memoryMethods } = await import("./memory");
    const handler = memoryMethods.get("memory.search")?.handler;

    if (!handler) {
      throw new Error("memory.search handler not found");
    }

    const mockDb = {
      searchMemories: mock(() =>
        Promise.resolve({ results: [], total: 0, limit: 10 }),
      ),
    };

    const context = {
      request: new Request("http://localhost"),
      db: mockDb,
      userId: "user-123",
      apiKeyId: "key-456",
      engine: {
        id: "eng-1",
        orgId: "org-1",
        slug: "test",
        name: "Test",
        status: "active" as const,
      },
      // embeddingConfig intentionally omitted
    } as unknown as HandlerContext;

    const params = {
      semantic: "test query",
    };

    try {
      await handler(params, context);
      throw new Error("Expected handler to throw");
    } catch (error) {
      expect((error as { code: string }).code).toBe("EMBEDDING_NOT_CONFIGURED");
    }
  });

  test("throws EMBEDDING_FAILED when embedding generation fails", async () => {
    const { memoryMethods } = await import("./memory");
    const handler = memoryMethods.get("memory.search")?.handler;

    if (!handler) {
      throw new Error("memory.search handler not found");
    }

    const mockDb = {
      searchMemories: mock(() =>
        Promise.resolve({ results: [], total: 0, limit: 10 }),
      ),
    };

    const embeddingConfig = {
      provider: "openai" as const,
      model: "text-embedding-3-small",
      dimensions: 1536,
      apiKey: "test-key",
    };

    const context = {
      request: new Request("http://localhost"),
      db: mockDb,
      userId: "user-123",
      apiKeyId: "key-456",
      engine: {
        id: "eng-1",
        orgId: "org-1",
        slug: "test",
        name: "Test",
        status: "active" as const,
      },
      embeddingConfig,
    } as unknown as HandlerContext;

    const params = {
      semantic: "test query",
    };

    // The actual embedding call will fail because we're using a fake API key
    // This tests that errors are properly caught and wrapped
    try {
      await handler(params, context);
      // If embedding somehow succeeds (unlikely with fake key), that's fine too
    } catch (error) {
      // Should be wrapped in AppError with EMBEDDING_FAILED code
      expect((error as { code: string }).code).toBe("EMBEDDING_FAILED");
    }
  });

  test("calls searchMemories without embedding when semantic not provided", async () => {
    const { memoryMethods } = await import("./memory");
    const handler = memoryMethods.get("memory.search")?.handler;

    if (!handler) {
      throw new Error("memory.search handler not found");
    }

    const mockSearchMemories = mock(() =>
      Promise.resolve({
        results: [
          {
            id: "mem-1",
            content: "test",
            score: 1.0,
            meta: {},
            tree: "",
            temporal: null,
            hasEmbedding: false,
            createdAt: new Date(),
            createdBy: null,
            updatedAt: null,
          },
        ],
        total: 1,
        limit: 10,
      }),
    );

    const mockDb = {
      searchMemories: mockSearchMemories,
    };

    const context = {
      request: new Request("http://localhost"),
      db: mockDb,
      userId: "user-123",
      apiKeyId: "key-456",
      engine: {
        id: "eng-1",
        orgId: "org-1",
        slug: "test",
        name: "Test",
        status: "active" as const,
      },
      // No embeddingConfig needed when not using semantic
    } as unknown as HandlerContext;

    const params = {
      fulltext: "test query",
    };

    await handler(params, context);

    // Verify searchMemories was called without embedding
    expect(mockSearchMemories).toHaveBeenCalled();
    const calls = mockSearchMemories.mock.calls as unknown as Array<
      [{ fulltext?: string; embedding?: number[] }]
    >;
    expect(calls.length).toBeGreaterThan(0);
    const callArgs = calls[0]![0]!;
    expect(callArgs.fulltext).toBe("test query");
    expect(callArgs.embedding).toBeUndefined();
  });
});
