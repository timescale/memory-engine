# Semantic Search Query Embedding

**Goal:** Enable semantic search in `memory.search` by generating embeddings for query text at request time.

**Status:** Design approved

---

## Context

The `memory.search` RPC method accepts a `semantic` parameter for vector similarity search, but the server doesn't generate embeddings for the query. The embedding infrastructure exists in `packages/embedding` (used by the background worker), but the server doesn't use it. Result: semantic search silently returns no results.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Config source | Environment variables | Server-wide config, simpler than per-engine |
| Provider | OpenAI only (for now) | Hosted platform uses OpenAI; Ollama support can be added later |
| Generation location | Inline in search handler | Simplest approach; middleware adds complexity without benefit |
| Error handling | Fail the request | Clear errors; client can decide to retry or fall back |
| Dimensions validation | Trust operator | Document requirements; don't over-engineer |

## Environment Variables

**Required (when semantic search is used):**

| Variable | Description | Example |
|----------|-------------|---------|
| `EMBEDDING_API_KEY` | OpenAI API key | `sk-...` |
| `EMBEDDING_MODEL` | Model identifier | `text-embedding-3-small` |
| `EMBEDDING_DIMENSIONS` | Vector dimensions | `1536` |

**Optional:**

| Variable | Description | Default |
|----------|-------------|---------|
| `EMBEDDING_BASE_URL` | API base URL | `https://api.openai.com/v1` |

**Note:** If embedding env vars are not set, the server still starts but semantic search returns an error explaining that embedding is not configured.

## Request Flow

```
Client                    Server                         OpenAI
  |                         |                              |
  |-- memory.search ------->|                              |
  |   {semantic: "query"}   |                              |
  |                         |-- POST /v1/embeddings ------>|
  |                         |   {input: "query", ...}      |
  |                         |<-- embedding vector ---------|
  |                         |                              |
  |                         |-- db.searchMemories() -->    |
  |                         |   {embedding: [...]}         |
  |<-- results -------------|                              |
```

## Changes

### `packages/server/context.ts`

Add optional embedding config to `ServerContext`:

```typescript
import type { EmbeddingConfig } from "@memory-engine/embedding";

export interface ServerContext {
  accountsDb: AccountsDB;
  engineSql: SQL;
  embeddingConfig?: EmbeddingConfig;  // Optional - semantic search disabled if not set
}
```

### `packages/server/index.ts`

Read embedding config from environment:

```typescript
// Embedding config (optional - semantic search disabled if not set)
const embeddingConfig = buildEmbeddingConfig();

const router = createRouter({ accountsDb, engineSql, embeddingConfig });
```

Helper function:

```typescript
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
```

### `packages/server/router.ts`

Pass embedding config through to engine RPC context:

```typescript
const engineRpcHandler = createRpcHandler(engineMethods, async (request) => {
  const auth = await authenticateEngine(request, accountsDb, engineSql);
  if (!auth.ok) {
    return auth.error;
  }
  const ctx = auth.context;
  if (ctx.type !== "engine") {
    throw new Error("Unexpected auth context type");
  }
  return {
    db: ctx.db,
    userId: ctx.userId,
    apiKeyId: ctx.apiKeyId,
    engine: ctx.engine,
    embeddingConfig,  // Add this
  };
});
```

### `packages/server/rpc/engine/types.ts`

Add embedding config to `EngineContext`:

```typescript
import type { EmbeddingConfig } from "@memory-engine/embedding";

export interface EngineContext extends HandlerContext {
  db: EngineDB;
  userId: string;
  apiKeyId: string;
  engine: EngineInfo;
  embeddingConfig?: EmbeddingConfig;  // Add this
}
```

Update type guard:

```typescript
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
```

### `packages/server/rpc/engine/memory.ts`

Generate embedding when `semantic` is provided:

```typescript
import { generateEmbedding } from "@memory-engine/embedding";
import { AppError } from "../errors";

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
        "Semantic search requires embedding configuration. Set EMBEDDING_API_KEY, EMBEDDING_MODEL, and EMBEDDING_DIMENSIONS.",
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

### `packages/server/rpc/errors.ts`

Add new error codes to `APP_ERROR_CODES`:

```typescript
export const APP_ERROR_CODES = {
  // ... existing codes
  EMBEDDING_NOT_CONFIGURED: "EMBEDDING_NOT_CONFIGURED",
  EMBEDDING_FAILED: "EMBEDDING_FAILED",
} as const;
```

### `packages/server/package.json`

Add dependency:

```json
{
  "dependencies": {
    "@memory-engine/embedding": "workspace:*"
  }
}
```

## Error Scenarios

| Scenario | Error Code | Message |
|----------|------------|---------|
| Semantic search without config | `EMBEDDING_NOT_CONFIGURED` | "Semantic search requires embedding configuration..." |
| OpenAI API error | `EMBEDDING_FAILED` | "Failed to generate embedding: {details}" |
| Rate limited | `EMBEDDING_FAILED` | "Failed to generate embedding: Rate limited" |
| Invalid API key | `EMBEDDING_FAILED` | "Failed to generate embedding: Invalid API key" |

## Testing

1. **Unit test:** Mock `generateEmbedding`, verify it's called with correct params
2. **Unit test:** Verify error when `semantic` provided but no config
3. **Unit test:** Verify error propagation when embedding fails
4. **Integration test:** With real OpenAI key, verify end-to-end semantic search

## Documentation

Update server README or deployment docs to include:

- New environment variables
- Note that `EMBEDDING_DIMENSIONS` must match the dimensions used when memories were created
- Note that semantic search is disabled if embedding vars are not set

## Future Considerations

- **Ollama support:** Add `EMBEDDING_PROVIDER` env var, update `buildEmbeddingConfig()` to handle `ollama`
- **Caching:** Cache query embeddings for repeated searches (low priority - queries are usually unique)
- **Metrics:** Track embedding latency and error rates in telemetry
