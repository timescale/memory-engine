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
import { clipToCharLimit, generateEmbedding } from "@memory.build/embedding";
import { ACCESS } from "@memory.build/engine/core";
import type {
  SearchResultItem,
  Memory as SpaceMemory,
} from "@memory.build/engine/space";
import type {
  MemoryBatchCreateParams,
  MemoryBatchCreateResult,
  MemoryCopyParams,
  MemoryCopyResult,
  MemoryCountTreeParams,
  MemoryCountTreeResult,
  MemoryCreateParams,
  MemoryDeleteByPathParams,
  MemoryDeleteParams,
  MemoryDeleteResult,
  MemoryDeleteTreeParams,
  MemoryDeleteTreeResult,
  MemoryEmbeddingStatusResult,
  MemoryGetByPathParams,
  MemoryGetParams,
  MemoryMoveParams,
  MemoryMoveResult,
  MemoryReconcileTreeParams,
  MemoryReconcileTreeResult,
  MemoryResponse,
  MemorySearchParams,
  MemorySearchResult,
  MemoryTreeParams,
  MemoryTreeResult,
  MemoryUpdateParams,
} from "@memory.build/protocol/memory";
import {
  memoryBatchCreateParams,
  memoryCopyParams,
  memoryCountTreeParams,
  memoryCreateParams,
  memoryDeleteByPathParams,
  memoryDeleteParams,
  memoryDeleteTreeParams,
  memoryEmbeddingStatusParams,
  memoryGetByPathParams,
  memoryGetParams,
  memoryMoveParams,
  memoryReconcileTreeParams,
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
// Constants
// =============================================================================

/**
 * Max characters of a semantic search query that get embedded. Comfortably
 * above any meaningful query, but bounds the cost of embedding (and tokenizing)
 * a pathologically large input on the request path. The embedding layer still
 * enforces the model's exact token limit.
 */
const MAX_SEMANTIC_QUERY_CHARS = 8192;

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
  // unique_violation — a duplicate id, or a (tree, name) clash (create with no
  // upsert/replace directive, or a rename/move into a taken name).
  if (code === "23505") {
    throw new AppError(
      "CONFLICT",
      "Memory already exists (id or tree/name conflict)",
    );
  }
  if (code === "ME002") {
    throw new AppError(
      "CONFLICT",
      "Memory was modified; the version_hash is stale. Fetch the memory again to get the latest version_hash, re-apply your changes over the latest vesion, and retry",
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
    name: m.name,
    temporal: parseTemporal(m.temporal),
    version: m.version,
    versionHash: m.versionHash,
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

/**
 * Split a `folder/name` path at its final `/`: the last segment is the name,
 * the rest is the tree. A path with no `/` is a root-level name.
 */
function splitPath(path: string): { tree: string; name: string } {
  const i = path.lastIndexOf("/");
  return i === -1
    ? { tree: "", name: path }
    : { tree: path.slice(0, i), name: path.slice(i + 1) };
}

/**
 * Resolve a `folder/name` path to a memory id, expanding `~` and normalizing
 * the tree. NOT_FOUND when no such named memory exists (or it's unreadable).
 */
async function resolvePath(
  ctx: SpaceRpcContext,
  path: string,
): Promise<string> {
  const { tree, name } = splitPath(path);
  if (name === "") {
    throw new AppError("VALIDATION_ERROR", "path must end in a name");
  }
  const id = await guard(() =>
    ctx.store.resolveMemoryId(ctx.treeAccess, inputTreePath(ctx, tree), name),
  );
  if (id == null) {
    throw new AppError("NOT_FOUND", `Memory not found: ${path}`);
  }
  return id;
}

/** memory.create */
async function memoryCreate(
  params: MemoryCreateParams,
  context: HandlerContext,
): Promise<MemoryResponse> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const { store, treeAccess } = ctx;

  const tree = inputTreePath(ctx, params.tree);
  // createMemory returns the row's STORED id for every outcome — including a
  // skip ('ignore'/'replace' no-op), where for a named row that's the existing
  // row's id (which may differ from a submitted id; name wins over id). A bare
  // conflict (default onConflict 'error') raises 23505 → CONFLICT via guard.
  const { id } = await guard(() =>
    store.createMemory(treeAccess, {
      id: params.id ?? undefined,
      content: params.content,
      meta: params.meta ?? undefined,
      tree,
      name: params.name ?? undefined,
      temporal: formatTemporal(params.temporal),
      onConflict: params.onConflict ?? undefined,
    }),
  );
  const memory = await store.getMemory(treeAccess, id);
  if (!memory) {
    throw new AppError("INTERNAL_ERROR", "Created memory could not be read");
  }
  return toMemoryResponse(memory, ctx);
}

/**
 * memory.batchCreate — atomic across the batch (one set-based statement,
 * `batch_create_memory`).
 *
 * Returns one `{ id, status }` per submitted memory, in request order, so the
 * caller can map each result back to its input and see whether it was inserted,
 * updated (rewritten by `onConflict: 'replace'`), or skipped (already current,
 * or `onConflict: 'ignore'`). A duplicate idempotency key within one batch
 * raises.
 */
async function memoryBatchCreate(
  params: MemoryBatchCreateParams,
  context: HandlerContext,
): Promise<MemoryBatchCreateResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const { store, treeAccess } = ctx;

  const rows = await guard(() =>
    store.batchCreateMemories(
      treeAccess,
      params.memories.map((m) => ({
        id: m.id ?? undefined,
        content: m.content,
        meta: m.meta ?? undefined,
        tree: inputTreePath(ctx, m.tree),
        name: m.name ?? undefined,
        temporal: formatTemporal(m.temporal),
      })),
      params.onConflict ?? undefined,
    ),
  );
  return { results: rows.map((r) => ({ id: r.id, status: r.status })) };
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

/** memory.getByPath — address a named memory by its folder/name path. */
async function memoryGetByPath(
  params: MemoryGetByPathParams,
  context: HandlerContext,
): Promise<MemoryResponse> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const { store, treeAccess } = ctx;

  const id = await resolvePath(ctx, params.path);
  const memory = await guard(() => store.getMemory(treeAccess, id));
  if (!memory) {
    throw new AppError("NOT_FOUND", `Memory not found: ${params.path}`);
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
    name?: string | null;
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
  // null clears the name; a string sets/renames; undefined leaves it unchanged.
  if (params.name !== undefined) {
    patch.name = params.name;
  }
  if (params.temporal !== undefined) {
    patch.temporal =
      params.temporal === null
        ? null
        : (formatTemporal(params.temporal) ?? null);
  }

  const ok = await guard(() =>
    store.patchMemory(treeAccess, params.id, params.versionHash, patch),
  );
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

/** memory.deleteByPath — delete one named memory by its folder/name path. */
async function memoryDeleteByPath(
  params: MemoryDeleteByPathParams,
  context: HandlerContext,
): Promise<MemoryDeleteResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const { store, treeAccess } = ctx;

  const id = await resolvePath(ctx, params.path);
  const deleted = await guard(() => store.deleteMemory(treeAccess, id));
  if (!deleted) {
    throw new AppError("NOT_FOUND", `Memory not found: ${params.path}`);
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
    // Clip the query before embedding. The embedding layer also truncates to
    // the model's token limit, but a query longer than this carries no useful
    // semantic signal — capping here bounds tokenizer CPU on the request path
    // (the embedding worker shares this process's event loop).
    const query = clipToCharLimit(params.semantic, MAX_SEMANTIC_QUERY_CHARS);
    try {
      vec = (await generateEmbedding(query, embeddingConfig)).embedding;
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

  // Classify the tree filter so a wildcard (`foo.*`) binds to lquery and a
  // boolean label search (`a & b`) to ltxtquery, rather than all casting to
  // ltree (which throws on query syntax).
  const treeFilter = params.tree ? inputTreeFilter(ctx, params.tree) : null;
  const filters = {
    ltree: treeFilter?.kind === "ltree" ? treeFilter.value : undefined,
    lquery: treeFilter?.kind === "lquery" ? treeFilter.value : undefined,
    ltxtquery: treeFilter?.kind === "ltxtquery" ? treeFilter.value : undefined,
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

/** memory.copy */
async function memoryCopy(
  params: MemoryCopyParams,
  context: HandlerContext,
): Promise<MemoryCopyResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const { store, treeAccess } = ctx;

  const count = await guard(() =>
    store.copyTree(
      treeAccess,
      inputTreePath(ctx, params.source),
      inputTreePath(ctx, params.destination),
      params.dryRun ?? false,
    ),
  );
  return { count };
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

/**
 * memory.reconcileTree — set-based reconcile-delete for importer-maintained
 * subtrees. The SQL function owns the semantics (named rows under root,
 * metaContains ownership scope, keep-list anti-join, up-front write gate);
 * this handler only normalizes paths in and denormalizes the affected rows
 * out.
 */
async function memoryReconcileTree(
  params: MemoryReconcileTreeParams,
  context: HandlerContext,
): Promise<MemoryReconcileTreeResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const { store, treeAccess } = ctx;

  const root = inputTreePath(ctx, params.root);
  const keepTrees = params.keep.map((k) => inputTreePath(ctx, k.tree));
  const keepNames = params.keep.map((k) => k.name);

  const rows = await guard(() =>
    store.reconcileTree(
      treeAccess,
      root,
      params.metaContains,
      keepTrees,
      keepNames,
      params.dryRun ?? false,
    ),
  );
  return {
    count: rows.length,
    paths: rows.map((r) => `${displayTreePath(ctx, r.tree)}/${r.name}`),
  };
}

/** memory.countTree */
async function memoryCountTree(
  params: MemoryCountTreeParams,
  context: HandlerContext,
): Promise<MemoryCountTreeResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const { store, treeAccess } = ctx;

  const treeFilter = inputTreeFilter(ctx, params.tree);
  if (!treeFilter) {
    throw new AppError("VALIDATION_ERROR", "tree filter is required");
  }

  const count = await guard(() =>
    store.countTree(
      treeAccess,
      {
        tree: treeFilter.kind === "ltree" ? treeFilter.value : undefined,
        lquery: treeFilter.kind === "lquery" ? treeFilter.value : undefined,
        ltxtquery:
          treeFilter.kind === "ltxtquery" ? treeFilter.value : undefined,
      },
      ACCESS.read,
      params.maxCount,
    ),
  );
  return { count };
}

/**
 * memory.embeddingStatus — space-wide embedding backlog snapshot.
 *
 * Aggregate counts only (no content), space-wide by design, so any authenticated
 * space member may call it. Surfaces async embedding progress after an import
 * (TNT-188).
 */
async function memoryEmbeddingStatus(
  _params: Record<string, never>,
  context: HandlerContext,
): Promise<MemoryEmbeddingStatusResult> {
  assertSpaceRpcContext(context);
  const { store } = context as SpaceRpcContext;

  const stats = await guard(() => store.queueStats());
  return {
    pending: stats.pending,
    inFlight: stats.inFlight,
    waiting: stats.waiting,
    failed: stats.failed,
    oldestPendingAt: stats.oldestPendingAt?.toISOString() ?? null,
  };
}

// =============================================================================
// Registry
// =============================================================================

export const memoryDataMethods = buildRegistry()
  .register("memory.create", memoryCreateParams, memoryCreate)
  .register("memory.batchCreate", memoryBatchCreateParams, memoryBatchCreate)
  .register("memory.get", memoryGetParams, memoryGet)
  .register("memory.getByPath", memoryGetByPathParams, memoryGetByPath)
  .register("memory.update", memoryUpdateParams, memoryUpdate)
  .register("memory.delete", memoryDeleteParams, memoryDelete)
  .register("memory.deleteByPath", memoryDeleteByPathParams, memoryDeleteByPath)
  .register("memory.search", memorySearchParams, memorySearch)
  .register("memory.tree", memoryTreeParams, memoryTree)
  .register("memory.copy", memoryCopyParams, memoryCopy)
  .register("memory.move", memoryMoveParams, memoryMove)
  .register("memory.deleteTree", memoryDeleteTreeParams, memoryDeleteTree)
  .register(
    "memory.reconcileTree",
    memoryReconcileTreeParams,
    memoryReconcileTree,
  )
  .register("memory.countTree", memoryCountTreeParams, memoryCountTree)
  .register(
    "memory.embeddingStatus",
    memoryEmbeddingStatusParams,
    memoryEmbeddingStatus,
  )
  .build();
