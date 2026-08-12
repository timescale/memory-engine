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
  MemoryEvent,
  MemoryEventContext,
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
  MemoryDeleteOrphansInTreeParams,
  MemoryDeleteOrphansInTreeResult,
  MemoryDeleteParams,
  MemoryDeleteResult,
  MemoryDeleteTreeParams,
  MemoryDeleteTreeResult,
  MemoryEmbeddingStatusResult,
  MemoryEventResponse,
  MemoryGetByPathParams,
  MemoryGetParams,
  MemoryHistoryParams,
  MemoryHistoryResult,
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
  memoryCopyParams,
  memoryCountTreeParams,
  memoryCreateParams,
  memoryDeleteByPathParams,
  memoryDeleteOrphansInTreeParams,
  memoryDeleteParams,
  memoryDeleteTreeParams,
  memoryEmbeddingStatusParams,
  memoryGetByPathParams,
  memoryGetParams,
  memoryHistoryParams,
  memoryMoveParams,
  memorySearchParams,
  memoryTreeParams,
  memoryUpdateParams,
} from "@memory.build/protocol/memory";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import {
  callerHomePrefix,
  displayTreePath,
  inputTreeFilter,
  inputTreePath,
} from "./support";
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
 *
 * `syntax_error` (42601) is also caller-caused here: ltree's `lquery` /
 * `ltxtquery` parsers report a malformed pattern (`~|~`, `a&&`) with that
 * code rather than 22P02, and a tree filter is caller-supplied — so it must
 * surface as a validation error, not an opaque "Internal error".
 */
function mapSpaceError(e: unknown): never {
  const code = (e as { code?: string }).code;
  if (code === "42501") {
    throw new AppError("FORBIDDEN", "Insufficient tree access");
  }
  if (code === "22023" || code === "22P02" || code === "42601") {
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

/**
 * Remove the caller's own home from the aggregate counts of its ancestor
 * prefixes, so the caller's home is counted only under `~` — never a second
 * time under a literal `home` root.
 *
 * `list_tree` explodes every memory into all of its prefixes, so a memory at
 * `home.<caller>.x` bumps the count of the bare `home` prefix. That ancestor is
 * NOT reverse-mapped to `~` by `displayTreePath` — it renders as a
 * literal `home` root — so their counts double-count the caller's own home,
 * which is already shown under `~`. We subtract the caller's own-home aggregate
 * (the count at `homePrefix` itself) from each strict ancestor of `homePrefix`,
 * dropping any ancestor that is left with nothing (e.g. the caller has access to
 * no other member's home). Other members' homes are untouched, so the `home`
 * root still shows them.
 */
export function dedupeOwnHome<T extends { tree: string; count: number }>(
  entries: T[],
  homePrefix: string | null,
): T[] {
  if (homePrefix === null) return entries;
  const own = entries.find((e) => e.tree === homePrefix)?.count ?? 0;
  if (own === 0) return entries;

  const result: T[] = [];
  for (const entry of entries) {
    // A strict ancestor of the caller's home — not the home prefix itself, nor
    // any of its descendants.
    if (homePrefix.startsWith(`${entry.tree}.`)) {
      const adjusted = entry.count - own;
      if (adjusted > 0) result.push({ ...entry, count: adjusted });
      // else: nothing left after removing the caller's own home — drop it.
    } else {
      result.push(entry);
    }
  }
  return result;
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

function toEventResponse(
  e: MemoryEvent,
  ctx: SpaceRpcContext,
): MemoryEventResponse {
  return {
    eventId: e.eventId,
    at: e.at.toISOString(),
    operation: e.operation,
    operationId: e.operationId,
    cause: e.cause,
    actor: e.actor,
    memoryId: e.memoryId,
    tree: displayTreePath(ctx, e.tree),
    name: e.name,
    meta: e.meta,
    temporal: parseTemporal(e.temporal),
    content: e.content,
    version: e.version,
    versionHash: e.versionHash,
  };
}

function eventContext(ctx: SpaceRpcContext, cause: string): MemoryEventContext {
  return {
    principal_id: ctx.principalId,
    principal_name: ctx.principalName,
    ...(ctx.apiKeyId === null
      ? {}
      : { api_key_id: ctx.apiKeyId, api_key_name: ctx.apiKeyName ?? "" }),
    cause,
  };
}

async function mutate<T>(
  ctx: SpaceRpcContext,
  cause: string,
  fn: (store: SpaceRpcContext["store"]) => Promise<T>,
): Promise<T> {
  return ctx.store.withEventContext(eventContext(ctx, cause), fn);
}

/**
 * Map every populated wire temporal filter onto the space search's temporal
 * params. The database combines predicates with AND.
 */
function mapTemporalFilter(tf: MemorySearchParams["temporal"]): {
  temporalWithin?: string;
  temporalOverlaps?: string;
  temporalBefore?: string;
  temporalAfter?: string;
  temporalContains?: string;
} {
  if (!tf) return {};
  return {
    temporalWithin: tf.within
      ? `[${tf.within.start},${tf.within.end})`
      : undefined,
    temporalOverlaps: tf.overlaps
      ? `[${tf.overlaps.start},${tf.overlaps.end})`
      : undefined,
    temporalBefore: tf.before,
    temporalAfter: tf.after,
    temporalContains: tf.contains,
  };
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
    mutate(ctx, "create", (store) =>
      store.createMemory(treeAccess, {
        id: params.id ?? undefined,
        content: params.content,
        meta: params.meta ?? undefined,
        tree,
        name: params.name ?? undefined,
        temporal: formatTemporal(params.temporal),
        onConflict: params.onConflict ?? undefined,
      }),
    ),
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
  const { treeAccess } = ctx;

  const rows = await guard(() =>
    mutate(ctx, "create", (store) =>
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

/** memory.history — read the append-only audit log (read-gated per event tree). */
async function memoryHistory(
  params: MemoryHistoryParams,
  context: HandlerContext,
): Promise<MemoryHistoryResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const { store, treeAccess } = ctx;

  const limit = params.limit ?? 20;
  const events = await guard(() =>
    store.getMemoryHistory(treeAccess, {
      memoryId: params.memoryId ?? undefined,
      tree: params.tree ? inputTreePath(ctx, params.tree) : undefined,
      operation: params.operation ?? undefined,
      operationId: params.operationId ?? undefined,
      limit,
      order: params.order ?? "desc",
    }),
  );
  return { events: events.map((e) => toEventResponse(e, ctx)), limit };
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
    mutate(ctx, "update", (store) =>
      store.patchMemory(treeAccess, params.id, params.versionHash, patch),
    ),
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
  const ctx = context as SpaceRpcContext;
  const { treeAccess } = ctx;

  const deleted = await guard(() =>
    mutate(ctx, "delete", (store) => store.deleteMemory(treeAccess, params.id)),
  );
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
  const { treeAccess } = ctx;

  const id = await resolvePath(ctx, params.path);
  const deleted = await guard(() =>
    mutate(ctx, "delete", (store) => store.deleteMemory(treeAccess, id)),
  );
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

  // semanticThreshold is a cosine similarity (0..1). The engine/SQL now speaks
  // similarity too (minSimilarity), converting to a max-distance bound internally,
  // so we pass it straight through — no conversion at this seam. Only meaningful
  // when a vector is present.
  const minSimilarity =
    vec && params.semanticThreshold != null
      ? params.semanticThreshold
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
    metaPredicate: params.metaPredicate ?? undefined,
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
        minSimilarity,
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
        minSimilarity,
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
  const raw = await guard(() => store.listTree(treeAccess, lquery));
  // The caller's own home is shown under `~`; strip it from the literal `home`
  // ancestor counts so it isn't counted a second time there.
  const entries = dedupeOwnHome(raw, callerHomePrefix(ctx));

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
  const { treeAccess } = ctx;

  const count = await guard(() =>
    mutate(ctx, "copy", (store) =>
      store.copyTree(
        treeAccess,
        inputTreePath(ctx, params.source),
        inputTreePath(ctx, params.destination),
        params.dryRun ?? false,
      ),
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
  const { treeAccess } = ctx;

  const count = await guard(() =>
    mutate(ctx, "move", (store) =>
      store.moveTree(
        treeAccess,
        inputTreePath(ctx, params.source),
        inputTreePath(ctx, params.destination),
        params.dryRun ?? false,
      ),
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
  const { treeAccess } = ctx;

  const count = await guard(() =>
    mutate(ctx, "delete_tree", (store) =>
      store.deleteTree(
        treeAccess,
        inputTreePath(ctx, params.tree),
        params.dryRun ?? false,
      ),
    ),
  );
  return { count };
}

/**
 * memory.deleteOrphansInTree — set-based orphan deletion for
 * importer-maintained subtrees. The SQL function owns the semantics (named rows under root,
 * metaContains ownership scope, keep-list anti-join, up-front write gate);
 * this handler only normalizes paths in and denormalizes the affected rows
 * out.
 */
async function memoryDeleteOrphansInTree(
  params: MemoryDeleteOrphansInTreeParams,
  context: HandlerContext,
): Promise<MemoryDeleteOrphansInTreeResult> {
  assertSpaceRpcContext(context);
  const ctx = context as SpaceRpcContext;
  const { treeAccess } = ctx;

  const root = inputTreePath(ctx, params.root);
  const keepTrees = params.keep.map((k) => inputTreePath(ctx, k.tree));
  const keepNames = params.keep.map((k) => k.name);

  const rows = await guard(() =>
    mutate(ctx, "delete_orphans", (store) =>
      store.deleteOrphansInTree(
        treeAccess,
        root,
        params.metaContains,
        keepTrees,
        keepNames,
        params.dryRun ?? false,
      ),
    ),
  );
  return {
    count: rows.length,
    paths: rows.map((r) => {
      // The empty root displays as "/" — don't double the separator for a
      // root-level named row.
      const dir = displayTreePath(ctx, r.tree);
      return dir === "/" ? `/${r.name}` : `${dir}/${r.name}`;
    }),
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
  .register("memory.history", memoryHistoryParams, memoryHistory)
  .register("memory.update", memoryUpdateParams, memoryUpdate)
  .register("memory.delete", memoryDeleteParams, memoryDelete)
  .register("memory.deleteByPath", memoryDeleteByPathParams, memoryDeleteByPath)
  .register("memory.search", memorySearchParams, memorySearch)
  .register("memory.tree", memoryTreeParams, memoryTree)
  .register("memory.copy", memoryCopyParams, memoryCopy)
  .register("memory.move", memoryMoveParams, memoryMove)
  .register("memory.deleteTree", memoryDeleteTreeParams, memoryDeleteTree)
  .register(
    "memory.deleteOrphansInTree",
    memoryDeleteOrphansInTreeParams,
    memoryDeleteOrphansInTree,
  )
  .register("memory.countTree", memoryCountTreeParams, memoryCountTree)
  .register(
    "memory.embeddingStatus",
    memoryEmbeddingStatusParams,
    memoryEmbeddingStatus,
  )
  .build();
