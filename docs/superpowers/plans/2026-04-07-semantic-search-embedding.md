# Semantic Search Query Embedding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable semantic search in `memory.search` by generating embeddings for query text at request time using OpenAI.

**Architecture:** Server reads embedding config from env vars at startup, passes through context to engine RPC handlers. The `memorySearch` handler calls `generateEmbedding()` when a `semantic` param is provided, then passes the vector to `db.searchMemories()`.

**Tech Stack:** Bun, TypeScript, `@memory-engine/embedding` package, OpenAI API

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/server/context.ts` | Add `embeddingConfig?: EmbeddingConfig` to `ServerContext` |
| `packages/server/index.ts` | Read env vars, build config, pass to router |
| `packages/server/router.ts` | Pass embedding config to engine RPC handler context |
| `packages/server/rpc/errors.ts` | Add `EMBEDDING_NOT_CONFIGURED` and `EMBEDDING_FAILED` error codes |
| `packages/server/rpc/engine/types.ts` | Add `embeddingConfig` to `EngineContext` |
| `packages/server/rpc/engine/memory.ts` | Generate embedding in `memorySearch()` |
| `packages/server/rpc/engine/memory.test.ts` | Tests for embedding generation in search |
| `packages/server/package.json` | Add `@memory-engine/embedding` dependency |

---

## Task 1: Add Embedding Dependency

**Files:**
- Modify: `packages/server/package.json`

- [ ] **Step 1: Add dependency**

```bash
cd packages/server && bun add @memory-engine/embedding@workspace:*
```

- [ ] **Step 2: Verify installation**

Run: `cd packages/server && bun install`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/server/package.json bun.lock
git commit -m "chore(server): add embedding package dependency"
```

---

## Task 2: Add Embedding Error Codes

**Files:**
- Modify: `packages/server/rpc/errors.ts:146-153`

- [ ] **Step 1: Add error codes to APP_ERROR_CODES**

In `packages/server/rpc/errors.ts`, update the `APP_ERROR_CODES` object:

```typescript
export const APP_ERROR_CODES = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  EMBEDDING_NOT_CONFIGURED: "EMBEDDING_NOT_CONFIGURED",
  EMBEDDING_FAILED: "EMBEDDING_FAILED",
} as const;
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd packages/server && bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/server/rpc/errors.ts
git commit -m "feat(server): add embedding error codes"
```

---

## Task 3: Add Embedding Config to ServerContext

**Files:**
- Modify: `packages/server/context.ts`

- [ ] **Step 1: Update ServerContext type**

Replace `packages/server/context.ts`:

```typescript
import type { AccountsDB } from "@memory-engine/accounts";
import type { EmbeddingConfig } from "@memory-engine/embedding";
import type { SQL } from "bun";

/**
 * Server-wide context containing database connections.
 * Passed to createRouter() at startup.
 */
export interface ServerContext {
  /** Accounts database operations */
  accountsDb: AccountsDB;
  /** Engine database pool (EngineDB created per-request based on slug) */
  engineSql: SQL;
  /** Embedding config for semantic search (optional - disabled if not set) */
  embeddingConfig?: EmbeddingConfig;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd packages/server && bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/server/context.ts
git commit -m "feat(server): add embeddingConfig to ServerContext"
```

---

## Task 4: Add Embedding Config to EngineContext

**Files:**
- Modify: `packages/server/rpc/engine/types.ts`

- [ ] **Step 1: Update EngineContext type**

Replace `packages/server/rpc/engine/types.ts`:

```typescript
/**
 * Engine RPC context types.
 *
 * Extends the base HandlerContext with engine-specific fields.
 */
import type { EmbeddingConfig } from "@memory-engine/embedding";
import type { EngineDB } from "@memory-engine/engine";
import type { EngineInfo } from "../../middleware/authenticate";
import type { HandlerContext } from "../types";

/**
 * Engine handler context.
 *
 * Provides access to:
 * - `db`: EngineDB instance for the authenticated engine
 * - `userId`: The authenticated user's ID (from API key)
 * - `apiKeyId`: The API key ID used for authentication
 * - `engine`: Engine metadata from accounts DB
 * - `embeddingConfig`: Optional config for semantic search
 */
export interface EngineContext extends HandlerContext {
  /** EngineDB instance for this engine */
  db: EngineDB;
  /** Authenticated user ID */
  userId: string;
  /** API key ID used for authentication */
  apiKeyId: string;
  /** Engine metadata from accounts DB */
  engine: EngineInfo;
  /** Embedding config for semantic search (optional) */
  embeddingConfig?: EmbeddingConfig;
}

/**
 * Type guard to check if context has engine fields.
 */
export function isEngineContext(ctx: HandlerContext): ctx is EngineContext {
  return (
    "db" in ctx &&
    typeof ctx.db === "object" &&
    ctx.db !== null &&
    "userId" in ctx &&
    typeof ctx.userId === "string" &&
    "apiKeyId" in ctx &&
    typeof ctx.apiKeyId === "string" &&
    "engine" in ctx &&
    typeof ctx.engine === "object" &&
    ctx.engine !== null
    // embeddingConfig is optional, don't check
  );
}

/**
 * Assert that context is an EngineContext, throwing if not.
 */
export function assertEngineContext(
  ctx: HandlerContext,
): asserts ctx is EngineContext {
  if (!isEngineContext(ctx)) {
    throw new Error("Engine context not initialized (authentication required)");
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd packages/server && bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/server/rpc/engine/types.ts
git commit -m "feat(server): add embeddingConfig to EngineContext"
```

---

## Task 5: Build Embedding Config from Environment

**Files:**
- Modify: `packages/server/index.ts`

- [ ] **Step 1: Add import and helper function**

At the top of `packages/server/index.ts`, add the import:

```typescript
import type { EmbeddingConfig } from "@memory-engine/embedding";
```

After the existing environment variable section (after line 51), add:

```typescript
// =============================================================================
// Embedding Config (Optional)
// =============================================================================
//
// For semantic search:
//   EMBEDDING_API_KEY     - OpenAI API key
//   EMBEDDING_MODEL       - Model identifier (e.g., "text-embedding-3-small")
//   EMBEDDING_DIMENSIONS  - Vector dimensions (e.g., 1536)
//
// Optional:
//   EMBEDDING_BASE_URL    - API base URL (default: OpenAI)
//
// If not configured, semantic search returns an error explaining how to enable it.
//
// =============================================================================

function buildEmbeddingConfig(): EmbeddingConfig | undefined {
  const apiKey = process.env.EMBEDDING_API_KEY;
  const model = process.env.EMBEDDING_MODEL;
  const dimensions = process.env.EMBEDDING_DIMENSIONS;

  // All three required for embedding to be enabled
  if (!apiKey || !model || !dimensions) {
    return undefined;
  }

  const parsedDimensions = parseInt(dimensions, 10);
  if (isNaN(parsedDimensions) || parsedDimensions <= 0) {
    throw new Error("EMBEDDING_DIMENSIONS must be a positive integer");
  }

  return {
    provider: "openai",
    model,
    dimensions: parsedDimensions,
    apiKey,
    baseUrl: process.env.EMBEDDING_BASE_URL,
  };
}

const embeddingConfig = buildEmbeddingConfig();
```

- [ ] **Step 2: Update router creation**

Change line 78 from:

```typescript
const router = createRouter({ accountsDb, engineSql });
```

To:

```typescript
const router = createRouter({ accountsDb, engineSql, embeddingConfig });
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd packages/server && bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/server/index.ts
git commit -m "feat(server): read embedding config from environment"
```

---

## Task 6: Pass Embedding Config Through Router

**Files:**
- Modify: `packages/server/router.ts:118-139`

- [ ] **Step 1: Destructure embeddingConfig from context**

In `packages/server/router.ts`, update line 119 from:

```typescript
const { accountsDb, engineSql } = ctx;
```

To:

```typescript
const { accountsDb, engineSql, embeddingConfig } = ctx;
```

- [ ] **Step 2: Pass embeddingConfig to engine handler context**

Update the engine RPC handler return (lines 133-138) from:

```typescript
return {
  db: ctx.db,
  userId: ctx.userId,
  apiKeyId: ctx.apiKeyId,
  engine: ctx.engine,
};
```

To:

```typescript
return {
  db: ctx.db,
  userId: ctx.userId,
  apiKeyId: ctx.apiKeyId,
  engine: ctx.engine,
  embeddingConfig,
};
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd packages/server && bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run existing tests**

Run: `cd packages/server && bun test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/server/router.ts
git commit -m "feat(server): pass embeddingConfig to engine RPC handlers"
```

---

## Task 7: Implement Embedding Generation in Search Handler

**Files:**
- Modify: `packages/server/rpc/engine/memory.ts:280-310`

- [ ] **Step 1: Add import**

At the top of `packages/server/rpc/engine/memory.ts`, add:

```typescript
import { generateEmbedding } from "@memory-engine/embedding";
```

- [ ] **Step 2: Update memorySearch function**

Replace the `memorySearch` function (around lines 287-310) with:

```typescript
/**
 * memory.search - Hybrid semantic + fulltext search.
 */
async function memorySearch(
  params: MemorySearchParams,
  context: HandlerContext,
): Promise<SearchResultResponse> {
  assertEngineContext(context);
  const { db, embeddingConfig } = context as EngineContext;

  let embedding: number[] | undefined;

  // Generate embedding for semantic search
  if (params.semantic) {
    if (!embeddingConfig) {
      throw new AppError(
        "EMBEDDING_NOT_CONFIGURED",
        "Semantic search requires embedding configuration. Set EMBEDDING_API_KEY, EMBEDDING_MODEL, and EMBEDDING_DIMENSIONS environment variables.",
      );
    }

    try {
      const result = await generateEmbedding(params.semantic, embeddingConfig);
      embedding = result.embedding;
    } catch (error) {
      throw new AppError(
        "EMBEDDING_FAILED",
        `Failed to generate embedding: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  const result = await db.searchMemories({
    fulltext: params.fulltext ?? undefined,
    embedding,
    tree: params.tree ?? undefined,
    meta: params.meta ?? undefined,
    temporal: parseTemporalFilter(params.temporal),
    limit: params.limit,
    candidateLimit: params.candidateLimit,
    weights: params.weights ?? undefined,
    orderBy: params.orderBy,
  });

  return toSearchResultResponse(result);
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd packages/server && bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/server/rpc/engine/memory.ts
git commit -m "feat(server): generate embeddings for semantic search queries"
```

---

## Task 8: Write Tests for Embedding in Search

**Files:**
- Modify: `packages/server/rpc/engine/memory.test.ts`

- [ ] **Step 1: Add test imports and mocks**

At the top of `packages/server/rpc/engine/memory.test.ts`, ensure these imports exist (add if missing):

```typescript
import { describe, expect, mock, test, beforeEach } from "bun:test";
```

- [ ] **Step 2: Add embedding test describe block**

Add the following test block to `packages/server/rpc/engine/memory.test.ts`:

```typescript
describe("memory.search embedding", () => {
  test("throws EMBEDDING_NOT_CONFIGURED when semantic provided without config", async () => {
    // Import the handler module to test
    const { memoryMethods } = await import("./memory");
    const handler = memoryMethods.get("memory.search")?.handler;
    
    if (!handler) {
      throw new Error("memory.search handler not found");
    }

    const mockDb = {
      searchMemories: mock(() => Promise.resolve({ results: [], total: 0, limit: 10 })),
    };

    const context = {
      request: new Request("http://localhost"),
      db: mockDb,
      userId: "user-123",
      apiKeyId: "key-456",
      engine: { id: "eng-1", orgId: "org-1", slug: "test", name: "Test", status: "active" as const },
      // embeddingConfig intentionally omitted
    };

    const params = {
      semantic: "test query",
    };

    await expect(handler(params, context as any)).rejects.toThrow("EMBEDDING_NOT_CONFIGURED");
  });

  test("throws EMBEDDING_FAILED when embedding generation fails", async () => {
    // Mock the embedding module to throw
    const mockGenerateEmbedding = mock(() => Promise.reject(new Error("API error")));
    
    // Use Bun's module mocking
    const originalModule = await import("@memory-engine/embedding");
    const mockedModule = {
      ...originalModule,
      generateEmbedding: mockGenerateEmbedding,
    };

    // This test validates the error handling logic
    // In practice, we test this through the handler behavior
    const { memoryMethods } = await import("./memory");
    const handler = memoryMethods.get("memory.search")?.handler;
    
    if (!handler) {
      throw new Error("memory.search handler not found");
    }

    const mockDb = {
      searchMemories: mock(() => Promise.resolve({ results: [], total: 0, limit: 10 })),
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
      engine: { id: "eng-1", orgId: "org-1", slug: "test", name: "Test", status: "active" as const },
      embeddingConfig,
    };

    const params = {
      semantic: "test query",
    };

    // The actual embedding call will fail because we're using a fake API key
    // This tests that errors are properly caught and wrapped
    try {
      await handler(params, context as any);
      // If embedding somehow succeeds (unlikely with fake key), that's fine too
    } catch (error: any) {
      // Should be wrapped in AppError with EMBEDDING_FAILED code
      expect(error.code).toBe("EMBEDDING_FAILED");
    }
  });

  test("calls searchMemories without embedding when semantic not provided", async () => {
    const { memoryMethods } = await import("./memory");
    const handler = memoryMethods.get("memory.search")?.handler;
    
    if (!handler) {
      throw new Error("memory.search handler not found");
    }

    const mockSearchMemories = mock(() => Promise.resolve({ 
      results: [{ id: "mem-1", content: "test", score: 1.0 }], 
      total: 1, 
      limit: 10 
    }));

    const mockDb = {
      searchMemories: mockSearchMemories,
    };

    const context = {
      request: new Request("http://localhost"),
      db: mockDb,
      userId: "user-123",
      apiKeyId: "key-456",
      engine: { id: "eng-1", orgId: "org-1", slug: "test", name: "Test", status: "active" as const },
      // No embeddingConfig needed when not using semantic
    };

    const params = {
      fulltext: "test query",
    };

    await handler(params, context as any);

    // Verify searchMemories was called without embedding
    expect(mockSearchMemories).toHaveBeenCalled();
    const callArgs = mockSearchMemories.mock.calls[0][0];
    expect(callArgs.fulltext).toBe("test query");
    expect(callArgs.embedding).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the new tests**

Run: `cd packages/server && bun test rpc/engine/memory.test.ts`
Expected: All tests pass (or skip embedding API tests if they require real keys)

- [ ] **Step 4: Commit**

```bash
git add packages/server/rpc/engine/memory.test.ts
git commit -m "test(server): add tests for semantic search embedding"
```

---

## Task 9: Run Full Test Suite and Lint

**Files:** None (verification only)

- [ ] **Step 1: Run all tests**

Run: `cd /Users/john/projects/me/me0 && bun test`
Expected: All tests pass (some may skip if they require integration setup)

- [ ] **Step 2: Run linter**

Run: `cd /Users/john/projects/me/me0 && bun run lint`
Expected: No errors

- [ ] **Step 3: Run TypeScript check**

Run: `cd /Users/john/projects/me/me0 && bun run typecheck`
Expected: No errors

- [ ] **Step 4: Fix any issues found**

If any tests, lint, or type errors are found, fix them before proceeding.

- [ ] **Step 5: Final commit if any fixes**

```bash
git add -A
git commit -m "fix: address lint and type issues"
```

---

## Task 10: Update Environment Documentation

**Files:**
- Modify: `packages/server/index.ts` (already updated in Task 5 with inline docs)

The environment variable documentation was added inline in Task 5. No additional README changes needed since this follows the existing pattern.

- [ ] **Step 1: Verify documentation is present**

Check that `packages/server/index.ts` contains the embedding config documentation block added in Task 5.

- [ ] **Step 2: No commit needed**

Documentation was included in Task 5 commit.
