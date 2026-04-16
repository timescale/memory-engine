/**
 * Engine RPC memory methods.
 *
 * Implements:
 * - memory.create: Create a single memory
 * - memory.batchCreate: Create multiple memories
 * - memory.get: Get memory by ID
 * - memory.update: Update memory content/meta/tree/temporal
 * - memory.delete: Delete memory by ID
 * - memory.search: Hybrid semantic + fulltext search
 * - memory.tree: Get tree structure with counts
 * - memory.move: Move memories from one tree path to another
 * - memory.deleteTree: Delete all memories under a tree path
 */
import { generateEmbedding } from "@memory.build/embedding";
import type { Memory, SearchResult, TreeNode } from "@memory.build/engine";
import type {
  MemoryBatchCreateParams,
  MemoryCreateParams,
  MemoryDeleteParams,
  MemoryDeleteTreeParams,
  MemoryGetParams,
  MemoryMoveParams,
  MemoryResponse,
  MemorySearchParams,
  MemorySearchResult,
  MemoryTreeParams,
  MemoryUpdateParams,
} from "@memory.build/protocol/engine/memory";
import {
  memoryBatchCreateParams,
  memoryCreateParams,
  memoryDeleteParams,
  memoryDeleteTreeParams,
  memoryGetParams,
  memoryMoveParams,
  memorySearchParams,
  memoryTreeParams,
  memoryUpdateParams,
} from "@memory.build/protocol/engine/memory";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { assertEngineContext, type EngineContext } from "./types";

/**
 * Convert a Memory to a serializable response.
 */
function toMemoryResponse(memory: Memory): MemoryResponse {
  return {
    id: memory.id,
    content: memory.content,
    meta: memory.meta,
    tree: memory.tree,
    temporal: memory.temporal
      ? {
          start: memory.temporal.start.toISOString(),
          end: memory.temporal.end.toISOString(),
        }
      : null,
    hasEmbedding: memory.hasEmbedding,
    createdAt: memory.createdAt.toISOString(),
    createdBy: memory.createdBy,
    updatedAt: memory.updatedAt?.toISOString() ?? null,
  };
}

/**
 * Convert SearchResult to serializable response.
 */
function toSearchResultResponse(result: SearchResult): MemorySearchResult {
  return {
    results: result.results.map((item) => ({
      ...toMemoryResponse(item),
      score: item.score,
    })),
    total: result.total,
    limit: result.limit,
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Parse temporal params into Date objects.
 */
function parseTemporal(
  temporal: { start: string; end?: string | null } | null | undefined,
): { start: Date; end?: Date } | undefined {
  if (!temporal) return undefined;
  return {
    start: new Date(temporal.start),
    end: temporal.end ? new Date(temporal.end) : undefined,
  };
}

/**
 * Parse temporal filter params into the format expected by engine ops.
 */
function parseTemporalFilter(
  temporal:
    | {
        contains?: string;
        overlaps?: { start: string; end: string };
        within?: { start: string; end: string };
      }
    | null
    | undefined,
):
  | {
      contains?: Date;
      overlaps?: [Date, Date];
      within?: [Date, Date];
    }
  | undefined {
  if (!temporal) return undefined;

  const result: {
    contains?: Date;
    overlaps?: [Date, Date];
    within?: [Date, Date];
  } = {};

  if (temporal.contains) {
    result.contains = new Date(temporal.contains);
  }
  if (temporal.overlaps) {
    result.overlaps = [
      new Date(temporal.overlaps.start),
      new Date(temporal.overlaps.end),
    ];
  }
  if (temporal.within) {
    result.within = [
      new Date(temporal.within.start),
      new Date(temporal.within.end),
    ];
  }

  return result;
}

// =============================================================================
// Method Handlers
// =============================================================================

/**
 * memory.create - Create a single memory.
 */
async function memoryCreate(
  params: MemoryCreateParams,
  context: HandlerContext,
): Promise<MemoryResponse> {
  assertEngineContext(context);
  const { db, userId } = context as EngineContext;

  const memory = await db.createMemory({
    id: params.id ?? undefined,
    content: params.content,
    meta: params.meta ?? undefined,
    tree: params.tree ?? undefined,
    temporal: parseTemporal(params.temporal),
    createdBy: userId,
  });

  return toMemoryResponse(memory);
}

/**
 * memory.batchCreate - Create multiple memories.
 */
async function memoryBatchCreate(
  params: MemoryBatchCreateParams,
  context: HandlerContext,
): Promise<{ ids: string[] }> {
  assertEngineContext(context);
  const { db, userId } = context as EngineContext;

  const ids = await db.batchCreateMemories(
    params.memories.map(
      (m: {
        id?: string | null;
        content: string;
        meta?: Record<string, unknown> | null;
        tree?: string | null;
        temporal?: { start: string; end?: string | null } | null;
      }) => ({
        id: m.id ?? undefined,
        content: m.content,
        meta: m.meta ?? undefined,
        tree: m.tree ?? undefined,
        temporal: parseTemporal(m.temporal),
        createdBy: userId,
      }),
    ),
  );

  return { ids };
}

/**
 * memory.get - Get memory by ID.
 */
async function memoryGet(
  params: MemoryGetParams,
  context: HandlerContext,
): Promise<MemoryResponse> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const memory = await db.getMemory(params.id);
  if (!memory) {
    throw new AppError("NOT_FOUND", `Memory not found: ${params.id}`);
  }

  return toMemoryResponse(memory);
}

/**
 * memory.update - Update memory content/meta/tree/temporal.
 */
async function memoryUpdate(
  params: MemoryUpdateParams,
  context: HandlerContext,
): Promise<MemoryResponse> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const memory = await db.updateMemory(params.id, {
    content: params.content ?? undefined,
    meta: params.meta ?? undefined,
    tree: params.tree ?? undefined,
    temporal: parseTemporal(params.temporal),
  });

  if (!memory) {
    throw new AppError("NOT_FOUND", `Memory not found: ${params.id}`);
  }

  return toMemoryResponse(memory);
}

/**
 * memory.delete - Delete memory by ID.
 */
async function memoryDelete(
  params: MemoryDeleteParams,
  context: HandlerContext,
): Promise<{ deleted: boolean }> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const deleted = await db.deleteMemory(params.id);
  if (!deleted) {
    throw new AppError("NOT_FOUND", `Memory not found: ${params.id}`);
  }

  return { deleted };
}

/**
 * memory.search - Hybrid semantic + fulltext search.
 */
async function memorySearch(
  params: MemorySearchParams,
  context: HandlerContext,
): Promise<MemorySearchResult> {
  assertEngineContext(context);
  const { db, embeddingConfig } = context as EngineContext;

  let embedding: number[] | undefined;

  // Generate embedding for semantic search
  if (params.semantic) {
    if (!embeddingConfig) {
      throw new AppError(
        "EMBEDDING_NOT_CONFIGURED",
        "Semantic search requires embedding configuration. Set EMBEDDING_API_KEY environment variable.",
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

  // grep alone would cause a full table scan — require at least one indexed criterion
  if (
    params.grep &&
    !params.fulltext &&
    !params.semantic &&
    !params.tree &&
    !params.meta &&
    !params.temporal
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "grep cannot be used alone (full table scan). Combine with semantic, fulltext, tree, meta, or temporal.",
    );
  }

  const result = await db.searchMemories({
    fulltext: params.fulltext ?? undefined,
    embedding,
    grep: params.grep ?? undefined,
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

/**
 * memory.tree - Get tree structure with counts.
 */
async function memoryTree(
  params: MemoryTreeParams,
  context: HandlerContext,
): Promise<{ nodes: TreeNode[] }> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const nodes = await db.getTree({
    tree: params.tree ?? undefined,
    levels: params.levels,
  });

  return { nodes };
}

/**
 * memory.move - Move memories from one tree path to another.
 */
async function memoryMove(
  params: MemoryMoveParams,
  context: HandlerContext,
): Promise<{ count: number }> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  const result = await db.moveTree(params.source, params.destination);
  return result;
}

/**
 * memory.deleteTree - Delete all memories under a tree path.
 */
async function memoryDeleteTree(
  params: MemoryDeleteTreeParams,
  context: HandlerContext,
): Promise<{ count: number }> {
  assertEngineContext(context);
  const { db } = context as EngineContext;

  if (params.dryRun) {
    // For dry run, we need to count without deleting
    // The engine ops doesn't support dry run directly, so we search and count
    const result = await db.searchMemories({
      tree: params.tree,
      limit: 1000, // Count up to 1000
    });
    return { count: result.total };
  }

  const result = await db.deleteTree(params.tree);
  return result;
}

// =============================================================================
// Registry
// =============================================================================

/**
 * Build the memory methods registry.
 */
export const memoryMethods = buildRegistry()
  .register("memory.create", memoryCreateParams, memoryCreate)
  .register("memory.batchCreate", memoryBatchCreateParams, memoryBatchCreate)
  .register("memory.get", memoryGetParams, memoryGet)
  .register("memory.update", memoryUpdateParams, memoryUpdate)
  .register("memory.delete", memoryDeleteParams, memoryDelete)
  .register("memory.search", memorySearchParams, memorySearch)
  .register("memory.tree", memoryTreeParams, memoryTree)
  .register("memory.move", memoryMoveParams, memoryMove)
  .register("memory.deleteTree", memoryDeleteTreeParams, memoryDeleteTree)
  .build();
