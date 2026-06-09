/**
 * Memory RPC data-plane methods (new model) — served at `/api/v1/memory/rpc`.
 *
 * Adapts the stable memory.* wire protocol onto the space data-plane store
 * (spaceStore). The wire is unchanged from the legacy engine RPC; the mapping
 * is handler-local. Lossy by design (see Phase 4C): `createdBy` is always null
 * (the space model has no per-memory creator) and search `total` is the returned
 * row count. `orderBy` applies to unranked (filter-only) search — chronological
 * by id, desc (default, newest first) or asc; ranked/hybrid search ignores it
 * (score-desc).
 */
import { generateEmbedding } from "@memory.build/embedding";
import { ACCESS } from "@memory.build/engine/core";
import type {
  SearchResultItem,
  Memory as SpaceMemory,
} from "@memory.build/engine/space";
import type {
  MemoryBatchCreateParams,
  MemoryBatchCreateResult,
  MemoryCountTreeParams,
  MemoryCountTreeResult,
  MemoryCreateParams,
  MemoryDeleteParams,
  MemoryDeleteResult,
  MemoryDeleteTreeParams,
  MemoryDeleteTreeResult,
  MemoryGetParams,
  MemoryMoveParams,
  MemoryMoveResult,
  MemoryResponse,
  MemorySearchParams,
  MemorySearchResult,
  MemoryTreeParams,
  MemoryTreeResult,
  MemoryUpdateParams,
} from "@memory.build/protocol/memory";
import {
  memoryBatchCreateParams,
  memoryCountTreeParams,
  memoryCreateParams,
  memoryDeleteParams,
  memoryDeleteTreeParams,
  memoryGetParams,
  memoryMoveParams,
  memorySearchParams,
  memoryTreeParams,
  memoryUpdateParams,
} from "@memory.build/protocol/memory";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { displayTreePath, inputTreeFilter, inputTreePath } from "./support";
import { assertSpaceRpcContext, type SpaceRpcContext } from "./types";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Translate a space SQL error into an AppError. The space functions raise
 * `insufficient_privilege` (42501) on access violations and
 * `invalid_parameter_value` (22023) / `invalid_text_representation` (22P02)
 * on malformed input; everything else propagates as an internal error.
 */
function mapSpaceError(e: unknown): never {
  const code = (e as { code?: string }).code;
  if (code === "42501") {
    throw new AppError("FORBIDDEN", "Insufficient tree access");
  }
  if (code === "22023" || code === "22P02") {
    throw new AppError(
      "VALIDATION_ERROR",
      e instanceof Error ? e.message : "Invalid parameter",
    );
  }
  throw e instanceof Error ? e : new Error(String(e));
}

/** Run a space-store call, mapping its SQL errors to AppErrors. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    return mapSpaceError(e);
  }
}

/**
 * Format a wire temporal `{start, end?}` into a PostgreSQL tstzrange string.
 * Point-in-time (no end / end == start) → `[t,t]`; otherwise `[start,end)`.
 * Mirrors the legacy engine's tstzrange formatting.
 */
function formatTemporal(
  t: { start: string; end?: string | null } | null | undefined,
): string | undefined {
  if (!t) return undefined;
  const start = t.start;
  const end = t.end ?? start;
  return start === end ? `[${start},${end}]` : `[${start},${end})`;
}

/**
 * Parse a PostgreSQL tstzrange string into a wire `{start, end}` (ISO),
 * normalizing the timestamps. Mirrors the legacy engine's parser.
 */
function parseTemporal(
  range: string | null,
): { start: string; end: string } | null {
  if (!range) return null;
  const m = range.match(/[[(]"?([^",]+)"?,"?([^",\])]+)"?[\])]/);
  if (!m) return null;
  const [, start, end] = m;
  if (!start || !end) return null;
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  };
}

/** ltree depth (label count); root ("") is 0. */
function nlevel(path: string): number {
  return path === "" ? 0 : path.split(".").length;
}

function toMemoryResponse(
  m: SpaceMemory,
  ctx: SpaceRpcContext,
): MemoryResponse {
  return {
    id: m.id,
    content: m.content,
    meta: m.meta,
    tree: displayTreePath(ctx, m.tree),
    temporal: parseTemporal(m.temporal),
    hasEmbedding: m.hasEmbedding,
    createdAt: m.createdAt.toISOString(),
    // The space model does not track a per-memory creator (4C decision).
    createdBy: null,
    updatedAt: m.updatedAt?.toISOString() ?? null,
  };
}

/**
 * Map the wire temporal filter (contains | overlaps | within — mutually
 * exclusive) onto the space search's temporal range params. A `contains`
 * point becomes an inclusive point-range overlap (true iff the memory's range
 * spans the instant).
 */
function mapTemporalFilter(tf: MemorySearchParams["temporal"]): {
  temporalWithin?: string;
  temporalOverlaps?: string;
} {
  if (!tf) return {};
  if (tf.within) {
    return { temporalWithin: `[${tf.within.start},${tf.within.end})` };
  }
  if (tf.overlaps) {
    return { temporalOverlaps: `[${tf.overlaps.start},${tf.overlaps.end})` };
  }
  if (tf.contains) {
    return { temporalOverlaps: `[${tf.contains},${tf.contains}]` };
  }
  return {};
}

// =============================================================================
// Method Handlers
// =============================================================================

/** memory.create */
async function memoryCreate(
  params: MemoryCreateParams,
  context: HandlerContext,
): Promise<MemoryResponse> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const { store, treeAccess } = ctx;

  const id = await guard(() =>
    store.createMemory(treeAccess, {
      id: params.id ?? undefined,
      content: params.content,
      meta: params.meta ?? undefined,
      tree: inputTreePath(ctx, params.tree),
      temporal: formatTemporal(params.temporal),
    }),
  );
  const memory = await store.getMemory(treeAccess, id);
  if (!memory) {
    throw new AppError("INTERNAL_ERROR", "Created memory could not be read");
  }
  return toMemoryResponse(memory, ctx);
}

/** memory.batchCreate — atomic across the batch. */
async function memoryBatchCreate(
  params: MemoryBatchCreateParams,
  context: HandlerContext,
): Promise<MemoryBatchCreateResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const { store, treeAccess } = ctx;

  const ids = await guard(() =>
    store.withTransaction(async (tx) => {
      const out: string[] = [];
      for (const m of params.memories) {
        out.push(
          await tx.createMemory(treeAccess, {
            id: m.id ?? undefined,
            content: m.content,
            meta: m.meta ?? undefined,
            tree: inputTreePath(ctx, m.tree),
            temporal: formatTemporal(m.temporal),
          }),
        );
      }
      return out;
    }),
  );
  return { ids };
}

/** memory.get */
async function memoryGet(
  params: MemoryGetParams,
  context: HandlerContext,
): Promise<MemoryResponse> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const { store, treeAccess } = ctx;

  const memory = await guard(() => store.getMemory(treeAccess, params.id));
  if (!memory) {
    throw new AppError("NOT_FOUND", `Memory not found: ${params.id}`);
  }
  return toMemoryResponse(memory, ctx);
}

/** memory.update */
async function memoryUpdate(
  params: MemoryUpdateParams,
  context: HandlerContext,
): Promise<MemoryResponse> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const { store, treeAccess } = ctx;

  const patch: {
    content?: string;
    meta?: Record<string, unknown>;
    tree?: string;
    temporal?: string | null;
  } = {};
  if (params.content !== undefined && params.content !== null) {
    patch.content = params.content;
  }
  if (params.meta !== undefined && params.meta !== null) {
    patch.meta = params.meta;
  }
  if (params.tree !== undefined && params.tree !== null) {
    patch.tree = inputTreePath(ctx, params.tree);
  }
  if (params.temporal !== undefined) {
    patch.temporal =
      params.temporal === null
        ? null
        : (formatTemporal(params.temporal) ?? null);
  }

  const ok = await guard(() => store.patchMemory(treeAccess, params.id, patch));
  if (!ok) {
    throw new AppError("NOT_FOUND", `Memory not found: ${params.id}`);
  }
  const memory = await store.getMemory(treeAccess, params.id);
  if (!memory) {
    throw new AppError("NOT_FOUND", `Memory not found: ${params.id}`);
  }
  return toMemoryResponse(memory, ctx);
}

/** memory.delete */
async function memoryDelete(
  params: MemoryDeleteParams,
  context: HandlerContext,
): Promise<MemoryDeleteResult> {
  assertSpaceRpcContext(context);
  const { store, treeAccess } = context as SpaceRpcContext;

  const deleted = await guard(() => store.deleteMemory(treeAccess, params.id));
  if (!deleted) {
    throw new AppError("NOT_FOUND", `Memory not found: ${params.id}`);
  }
  return { deleted };
}

/** memory.search — hybrid (fulltext+semantic) or single-arm / filter-only. */
async function memorySearch(
  params: MemorySearchParams,
  context: HandlerContext,
): Promise<MemorySearchResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const { store, treeAccess, embeddingConfig } = ctx;

  // Generate the query embedding for semantic search.
  let vec: number[] | undefined;
  if (params.semantic) {
    if (!embeddingConfig) {
      throw new AppError(
        "EMBEDDING_NOT_CONFIGURED",
        "Semantic search requires embedding configuration. Set EMBEDDING_API_KEY.",
      );
    }
    try {
      vec = (await generateEmbedding(params.semantic, embeddingConfig))
        .embedding;
    } catch (error) {
      throw new AppError(
        "EMBEDDING_FAILED",
        `Failed to generate embedding: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  const bm25 = params.fulltext ?? undefined;

  // grep alone would force a full table scan — require another indexed filter.
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

  // semanticThreshold is a cosine similarity (0..1); the space search filters by
  // cosine distance (= 1 - similarity), and only when a vector is present.
  const maxVecDist =
    vec && params.semanticThreshold != null
      ? 1 - params.semanticThreshold
      : undefined;

  const filters = {
    ltree: params.tree
      ? inputTreeFilter(ctx, params.tree) || undefined
      : undefined,
    metaContains: params.meta ?? undefined,
    regexp: params.grep ?? undefined,
    ...mapTemporalFilter(params.temporal),
  };
  const limit = params.limit ?? 10;

  let items: SearchResultItem[];
  if (bm25 && vec) {
    items = await guard(() =>
      store.hybridSearch(treeAccess, {
        bm25,
        vec,
        maxVecDist,
        candidateLimit: params.candidateLimit,
        fulltextWeight: params.weights?.fulltext,
        semanticWeight: params.weights?.semantic,
        limit,
        ...filters,
      }),
    );
  } else {
    items = await guard(() =>
      store.search(treeAccess, {
        bm25,
        vec,
        maxVecDist,
        limit,
        order: params.orderBy ?? undefined,
        ...filters,
      }),
    );
  }

  return {
    results: items.map((item) => ({
      ...toMemoryResponse(item, ctx),
      score: item.score,
    })),
    total: items.length,
    limit,
  };
}

/** memory.tree — node counts under a path, down to `levels` depth. */
async function memoryTree(
  params: MemoryTreeParams,
  context: HandlerContext,
): Promise<MemoryTreeResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const { store, treeAccess } = ctx;

  const base = params.tree ? inputTreePath(ctx, params.tree) : "";
  // `a.b.*` matches a.b and everything under it; `*` matches all paths.
  const lquery = base === "" ? "*" : `${base}.*`;
  const entries = await guard(() => store.listTree(treeAccess, lquery));

  const baseDepth = nlevel(base);
  const nodes = entries
    .filter((e) => {
      const depth = nlevel(e.tree);
      // strict descendants of the base path (exclude the base and its ancestors)
      if (depth <= baseDepth) return false;
      if (params.levels !== undefined && depth - baseDepth > params.levels) {
        return false;
      }
      return true;
    })
    .map((e) => ({ path: displayTreePath(ctx, e.tree), count: e.count }));

  return { nodes };
}

/** memory.move */
async function memoryMove(
  params: MemoryMoveParams,
  context: HandlerContext,
): Promise<MemoryMoveResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const { store, treeAccess } = ctx;

  const count = await guard(() =>
    store.moveTree(
      treeAccess,
      inputTreePath(ctx, params.source),
      inputTreePath(ctx, params.destination),
      params.dryRun ?? false,
    ),
  );
  return { count };
}

/** memory.deleteTree */
async function memoryDeleteTree(
  params: MemoryDeleteTreeParams,
  context: HandlerContext,
): Promise<MemoryDeleteTreeResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const { store, treeAccess } = ctx;

  const count = await guard(() =>
    store.deleteTree(
      treeAccess,
      inputTreePath(ctx, params.tree),
      params.dryRun ?? false,
    ),
  );
  return { count };
}

/** memory.countTree */
async function memoryCountTree(
  params: MemoryCountTreeParams,
  context: HandlerContext,
): Promise<MemoryCountTreeResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const { store, treeAccess } = ctx;

  const count = await guard(() =>
    store.countTree(
      treeAccess,
      { tree: inputTreePath(ctx, params.tree) },
      ACCESS.read,
    ),
  );
  return { count };
}

// =============================================================================
// Registry
// =============================================================================

export const memoryDataMethods = buildRegistry()
  .register("memory.create", memoryCreateParams, memoryCreate)
  .register("memory.batchCreate", memoryBatchCreateParams, memoryBatchCreate)
  .register("memory.get", memoryGetParams, memoryGet)
  .register("memory.update", memoryUpdateParams, memoryUpdate)
  .register("memory.delete", memoryDeleteParams, memoryDelete)
  .register("memory.search", memorySearchParams, memorySearch)
  .register("memory.tree", memoryTreeParams, memoryTree)
  .register("memory.move", memoryMoveParams, memoryMove)
  .register("memory.deleteTree", memoryDeleteTreeParams, memoryDeleteTree)
  .register("memory.countTree", memoryCountTreeParams, memoryCountTree)
  .build();
