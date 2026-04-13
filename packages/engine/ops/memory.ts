import type { SQL } from "bun";
import type {
  CreateMemoryParams,
  GetTreeParams,
  Memory,
  OpsContext,
  SearchParams,
  SearchResult,
  SearchResultItem,
  TemporalFilter,
  TreeNode,
  UpdateMemoryParams,
} from "../types";
import { withTx } from "./_tx";

// =============================================================================
// Row Types
// =============================================================================

interface MemoryRow {
  id: string;
  content: string;
  meta: Record<string, unknown>;
  tree: string;
  temporal: string | null;
  has_embedding: boolean;
  created_at: Date;
  created_by: string | null;
  updated_at: Date | null;
}

interface SearchRow extends MemoryRow {
  score: number | string; // Postgres may return as string
}

interface TreeRow {
  path: string;
  count: number;
}

// =============================================================================
// Tree Filter Detection
// =============================================================================

type TreeFilterType = "ltree" | "lquery" | "ltxtquery";

/**
 * Detect the type of tree filter based on the pattern.
 * - ltxtquery: Contains & (label search with AND)
 * - lquery: Contains pattern characters (*, {}, !, |, @, %)
 * - ltree: Plain path (default)
 */
function detectTreeFilterType(value: string): TreeFilterType {
  if (value.includes("&")) return "ltxtquery";
  if (/[*{}!|@%]/.test(value)) return "lquery";
  return "ltree";
}

// =============================================================================
// RRF Fusion
// =============================================================================

interface RankedResult {
  id: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion (RRF) algorithm for combining search results.
 *
 * RRF score = Σ (weight / (k + rank)) where rank is 1-indexed.
 *
 * @param bm25Results - Results from BM25 full-text search (ordered by relevance)
 * @param semanticResults - Results from semantic/vector search (ordered by relevance)
 * @param k - RRF constant (default 60, prevents high-ranked items from dominating)
 * @param weights - Relative weights for each search type
 */
function rrfFusion(
  bm25Results: Array<{ id: string }>,
  semanticResults: Array<{ id: string }>,
  k = 60,
  weights = { fulltext: 1.0, semantic: 1.0 },
): RankedResult[] {
  const scores = new Map<string, number>();

  // Score from BM25 results
  bm25Results.forEach((result, index) => {
    const rank = index + 1;
    const score = weights.fulltext / (k + rank);
    scores.set(result.id, (scores.get(result.id) ?? 0) + score);
  });

  // Score from semantic results
  semanticResults.forEach((result, index) => {
    const rank = index + 1;
    const score = weights.semantic / (k + rank);
    scores.set(result.id, (scores.get(result.id) ?? 0) + score);
  });

  // Sort by combined RRF score (descending)
  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

// =============================================================================
// Temporal Parsing/Formatting
// =============================================================================

/**
 * Parse a PostgreSQL tstzrange string into a temporal object
 */
function parseTemporal(
  range: string | null,
): { start: Date; end: Date } | null {
  if (!range) {
    return null;
  }

  // Parse format like ["2024-01-01 00:00:00+00","2024-01-02 00:00:00+00")
  const match = range.match(/[[(]"?([^",]+)"?,"?([^",\])]+)"?[\])]/);
  if (!match) {
    return null;
  }

  const startStr = match[1];
  const endStr = match[2];
  if (!startStr || !endStr) {
    return null;
  }
  return {
    start: new Date(startStr),
    end: new Date(endStr),
  };
}

/**
 * Format a temporal object as a PostgreSQL tstzrange string
 */
function formatTemporal(
  temporal: { start: Date; end?: Date } | null | undefined,
): string | null {
  if (!temporal) {
    return null;
  }

  const start = temporal.start.toISOString();
  const end = temporal.end?.toISOString() ?? start;

  // Point-in-time: [same,same] (inclusive both ends)
  // Range: [start,end) (inclusive-exclusive)
  if (start === end) {
    return `[${start},${end}]`;
  }
  return `[${start},${end})`;
}

// =============================================================================
// Row Conversion
// =============================================================================

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    content: row.content,
    meta: row.meta,
    tree: row.tree,
    temporal: parseTemporal(row.temporal),
    hasEmbedding: row.has_embedding,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
  };
}

function rowToSearchResult(row: SearchRow): SearchResultItem {
  return {
    ...rowToMemory(row),
    score: typeof row.score === "string" ? parseFloat(row.score) : row.score,
  };
}

// =============================================================================
// Query Builders
// =============================================================================

interface FilterParams {
  meta?: Record<string, unknown>;
  tree?: string;
  temporal?: TemporalFilter;
  grep?: string;
}

/**
 * Build common filter clauses for WHERE conditions
 */
function buildCommonFilters(
  params: FilterParams,
  valueOffset: number,
): { clauses: string[]; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];

  // Metadata containment filter
  if (params.meta && Object.keys(params.meta).length > 0) {
    const paramIdx = valueOffset + values.length + 1;
    clauses.push(`meta @> $${paramIdx}`);
    values.push(params.meta);
  }

  // Tree filter with auto-detection
  if (params.tree) {
    const paramIdx = valueOffset + values.length + 1;
    const filterType = detectTreeFilterType(params.tree);
    switch (filterType) {
      case "ltxtquery":
        clauses.push(`tree @ $${paramIdx}::ltxtquery`);
        break;
      case "lquery":
        clauses.push(`tree ~ $${paramIdx}::lquery`);
        break;
      case "ltree":
        clauses.push(`tree <@ $${paramIdx}::ltree`);
        break;
    }
    values.push(params.tree);
  }

  // Temporal filter
  if (params.temporal) {
    if (params.temporal.contains !== undefined) {
      const paramIdx = valueOffset + values.length + 1;
      clauses.push(`temporal @> $${paramIdx}::timestamptz`);
      const ts =
        params.temporal.contains instanceof Date
          ? params.temporal.contains.toISOString()
          : params.temporal.contains;
      values.push(ts);
    } else if (params.temporal.overlaps) {
      const paramIdx1 = valueOffset + values.length + 1;
      const paramIdx2 = valueOffset + values.length + 2;
      clauses.push(
        `temporal && tstzrange($${paramIdx1}::timestamptz, $${paramIdx2}::timestamptz, '[)')`,
      );
      const [start, end] = params.temporal.overlaps;
      values.push(
        start instanceof Date ? start.toISOString() : start,
        end instanceof Date ? end.toISOString() : end,
      );
    } else if (params.temporal.within) {
      const paramIdx1 = valueOffset + values.length + 1;
      const paramIdx2 = valueOffset + values.length + 2;
      clauses.push(
        `temporal <@ tstzrange($${paramIdx1}::timestamptz, $${paramIdx2}::timestamptz, '[)')`,
      );
      const [start, end] = params.temporal.within;
      values.push(
        start instanceof Date ? start.toISOString() : start,
        end instanceof Date ? end.toISOString() : end,
      );
    }
  }

  // Content regex filter (POSIX, case-sensitive)
  if (params.grep) {
    const paramIdx = valueOffset + values.length + 1;
    clauses.push(`content ~ $${paramIdx}`);
    values.push(params.grep);
  }

  return { clauses, values };
}

/**
 * Build a BM25 full-text search query
 */
async function buildBM25Query(
  sql: SQL,
  schema: string,
  params: FilterParams & {
    query: string;
    limit: number;
  },
): Promise<SearchRow[]> {
  const indexName = `${schema}.memory_content_bm25_idx`;
  const { clauses, values } = buildCommonFilters(params, 2); // $1=query, $2=limit

  const whereClause = clauses.length > 0 ? `AND ${clauses.join(" AND ")}` : "";

  const query = `
    SELECT
      id, content, meta, tree::text, temporal::text,
      embedding IS NOT NULL as has_embedding,
      created_at, created_by, updated_at,
      -(content <@> to_bm25query($1, '${indexName}')) as score
    FROM ${schema}.memory
    WHERE content <@> to_bm25query($1, '${indexName}') < 0
      ${whereClause}
    ORDER BY score DESC, created_at DESC
    LIMIT $2
  `;

  return sql.unsafe<SearchRow[]>(query, [
    params.query,
    params.limit,
    ...values,
  ]);
}

/**
 * Build a semantic/vector similarity search query
 */
async function buildSemanticQuery(
  sql: SQL,
  schema: string,
  params: FilterParams & {
    embedding: number[];
    limit: number;
  },
): Promise<SearchRow[]> {
  const { clauses, values } = buildCommonFilters(params, 2); // $1=embedding, $2=limit

  const whereClause = clauses.length > 0 ? `AND ${clauses.join(" AND ")}` : "";

  // Format embedding as PostgreSQL array literal
  const embeddingLiteral = `[${params.embedding.join(",")}]`;

  const query = `
    SELECT
      id, content, meta, tree::text, temporal::text,
      embedding IS NOT NULL as has_embedding,
      created_at, created_by, updated_at,
      (1 - (embedding <=> $1::halfvec)) as score
    FROM ${schema}.memory
    WHERE embedding IS NOT NULL
      AND (embedding <=> $1::halfvec) < 1.0
      ${whereClause}
    ORDER BY score DESC, created_at DESC
    LIMIT $2
  `;

  return sql.unsafe<SearchRow[]>(query, [
    embeddingLiteral,
    params.limit,
    ...values,
  ]);
}

/**
 * Build a filter-only query (no search ranking)
 */
async function buildFilterQuery(
  sql: SQL,
  schema: string,
  params: FilterParams & {
    limit: number;
    orderBy: "asc" | "desc";
  },
): Promise<SearchRow[]> {
  const { clauses, values } = buildCommonFilters(params, 1); // $1=limit

  const whereClause =
    clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const orderDirection = params.orderBy === "asc" ? "ASC" : "DESC";

  const query = `
    SELECT
      id, content, meta, tree::text, temporal::text,
      embedding IS NOT NULL as has_embedding,
      created_at, created_by, updated_at,
      1.0 as score
    FROM ${schema}.memory
    ${whereClause}
    ORDER BY created_at ${orderDirection}
    LIMIT $1
  `;

  return sql.unsafe<SearchRow[]>(query, [params.limit, ...values]);
}

/**
 * Fetch full memory rows by IDs, preserving order
 */
async function fetchByIds(
  sql: SQL,
  schema: string,
  ids: string[],
): Promise<MemoryRow[]> {
  if (ids.length === 0) {
    return [];
  }

  // Use array position to preserve order
  const idsArray = `{${ids.join(",")}}`;
  const query = `
    SELECT
      id, content, meta, tree::text, temporal::text,
      embedding IS NOT NULL as has_embedding,
      created_at, created_by, updated_at
    FROM ${schema}.memory
    WHERE id = ANY($1::uuid[])
    ORDER BY array_position($1::uuid[], id)
  `;

  return sql.unsafe<MemoryRow[]>(query, [idsArray]);
}

// =============================================================================
// Memory Ops
// =============================================================================

export function memoryOps(ctx: OpsContext) {
  const { schema } = ctx;

  return {
    /**
     * Create a new memory
     */
    async createMemory(params: CreateMemoryParams): Promise<Memory> {
      const { id, content, meta = {}, tree = "", temporal, createdBy } = params;

      const temporalStr = formatTemporal(temporal);

      return withTx(ctx, "write", "createMemory", async (sql) => {
        const rows = await sql<MemoryRow[]>`
          insert into ${sql.unsafe(schema)}.memory
            (${id ? sql`id,` : sql``} content, meta, tree, temporal, created_by)
          values
            (${id ? sql`${id},` : sql``} ${content}, ${meta}::jsonb, ${tree}::ltree, ${temporalStr}::tstzrange, ${createdBy ?? null})
          returning
            id, content, meta, tree::text, temporal::text,
            embedding is not null as has_embedding,
            created_at, created_by, updated_at
        `;
        const row = rows[0];
        if (!row) {
          throw new Error("Failed to create memory");
        }
        return rowToMemory(row);
      });
    },

    /**
     * Batch create memories
     */
    async batchCreateMemories(params: CreateMemoryParams[]): Promise<string[]> {
      if (params.length === 0) {
        return [];
      }

      return withTx(ctx, "write", "batchCreateMemories", async (sql) => {
        // TODO: Optimize with multi-row VALUES when Bun.sql supports it better
        const ids: string[] = [];
        for (const p of params) {
          const temporalStr = formatTemporal(p.temporal);
          const rows = await sql<{ id: string }[]>`
            insert into ${sql.unsafe(schema)}.memory
              (${p.id ? sql`id,` : sql``} content, meta, tree, temporal, created_by)
            values
              (${p.id ? sql`${p.id},` : sql``} ${p.content}, ${p.meta ?? {}}::jsonb, ${p.tree ?? ""}::ltree, ${temporalStr}::tstzrange, ${p.createdBy ?? null})
            returning id
          `;
          const row = rows[0];
          if (!row) {
            throw new Error("Failed to create memory in batch");
          }
          ids.push(row.id);
        }
        return ids;
      });
    },

    /**
     * Get a memory by ID
     */
    async getMemory(id: string): Promise<Memory | null> {
      return withTx(ctx, "read", "getMemory", async (sql) => {
        const rows = await sql<MemoryRow[]>`
          select
            id, content, meta, tree::text, temporal::text,
            embedding is not null as has_embedding,
            created_at, created_by, updated_at
          from ${sql.unsafe(schema)}.memory
          where id = ${id}
        `;
        const row = rows[0];
        return row ? rowToMemory(row) : null;
      });
    },

    /**
     * Update a memory
     */
    async updateMemory(
      id: string,
      params: UpdateMemoryParams,
    ): Promise<Memory | null> {
      const { content, meta, tree, temporal } = params;

      const updates: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (content !== undefined) {
        updates.push(`content = $${paramIndex++}`);
        values.push(content);
      }
      if (meta !== undefined) {
        updates.push(`meta = $${paramIndex++}::jsonb`);
        values.push(meta);
      }
      if (tree !== undefined) {
        updates.push(`tree = $${paramIndex++}::ltree`);
        values.push(tree);
      }
      if (temporal !== undefined) {
        updates.push(`temporal = $${paramIndex++}::tstzrange`);
        values.push(formatTemporal(temporal));
      }

      if (updates.length === 0) {
        return this.getMemory(id);
      }

      values.push(id);

      return withTx(ctx, "write", "updateMemory", async (sql) => {
        const query = `
          update ${schema}.memory
          set ${updates.join(", ")}
          where id = $${paramIndex}
          returning
            id, content, meta, tree::text, temporal::text,
            embedding is not null as has_embedding,
            created_at, created_by, updated_at
        `;

        const rows = await sql.unsafe<MemoryRow[]>(query, values);
        const row = rows[0];
        return row ? rowToMemory(row) : null;
      });
    },

    /**
     * Delete a memory by ID
     */
    async deleteMemory(id: string): Promise<boolean> {
      return withTx(ctx, "write", "deleteMemory", async (sql) => {
        const result = await sql`
          delete from ${sql.unsafe(schema)}.memory
          where id = ${id}
        `;
        return result.count > 0;
      });
    },

    /**
     * Delete all memories under a tree path
     */
    async deleteTree(treePath: string): Promise<{ count: number }> {
      return withTx(ctx, "write", "deleteTree", async (sql) => {
        const result = await sql`
          delete from ${sql.unsafe(schema)}.memory
          where tree <@ ${treePath}::ltree
        `;
        return { count: result.count };
      });
    },

    /**
     * Move memories from one tree path to another
     */
    async moveTree(
      source: string,
      destination: string,
    ): Promise<{ count: number }> {
      return withTx(ctx, "write", "moveTree", async (sql) => {
        const result = await sql`
          update ${sql.unsafe(schema)}.memory
          set tree = case
            when tree = ${source}::ltree then ${destination}::ltree
            else ${destination}::ltree || subpath(tree, nlevel(${source}::ltree))
          end
          where tree <@ ${source}::ltree
        `;
        return { count: result.count };
      });
    },

    /**
     * Search memories with hybrid BM25 + semantic search and RRF fusion.
     *
     * Search modes:
     * 1. Hybrid (fulltext + embedding): Both searches run in parallel, results fused with RRF
     * 2. BM25-only (fulltext): Full-text search using pg_textsearch
     * 3. Semantic-only (embedding): Vector similarity search using pgvector
     * 4. Filter-only (no search): Just filters by meta/tree/temporal
     *
     * Note: If `semantic` text is provided but no `embedding`, the caller is responsible
     * for generating the embedding first. This keeps the embedding provider decoupled.
     */
    async searchMemories(params: SearchParams): Promise<SearchResult> {
      const {
        fulltext,
        embedding,
        grep,
        meta,
        tree,
        temporal,
        limit = 10,
        candidateLimit = 30,
        weights = { fulltext: 1.0, semantic: 1.0 },
        orderBy = "desc",
      } = params;

      return withTx(ctx, "read", "searchMemories", async (sql) => {
        let results: SearchResultItem[];

        if (fulltext && embedding && embedding.length > 0) {
          // Case 1: Hybrid search with RRF fusion
          const [bm25Results, semanticResults] = await Promise.all([
            buildBM25Query(sql, schema, {
              query: fulltext,
              grep,
              meta,
              tree,
              temporal,
              limit: candidateLimit,
            }),
            buildSemanticQuery(sql, schema, {
              embedding,
              grep,
              meta,
              tree,
              temporal,
              limit: candidateLimit,
            }),
          ]);

          // Fuse results using RRF
          const fusedResults = rrfFusion(bm25Results, semanticResults, 60, {
            fulltext: weights.fulltext ?? 1.0,
            semantic: weights.semantic ?? 1.0,
          });

          // Take top N and fetch full records
          const topIds = fusedResults.slice(0, limit).map((r) => r.id);
          const scoreMap = new Map(fusedResults.map((r) => [r.id, r.score]));

          const rows = await fetchByIds(sql, schema, topIds);
          results = rows.map((row) => ({
            ...rowToMemory(row),
            score: scoreMap.get(row.id) ?? 0,
          }));
        } else if (fulltext) {
          // Case 2: BM25-only search
          const rows = await buildBM25Query(sql, schema, {
            query: fulltext,
            grep,
            meta,
            tree,
            temporal,
            limit,
          });
          results = rows.map(rowToSearchResult);
        } else if (embedding && embedding.length > 0) {
          // Case 3: Semantic-only search
          const rows = await buildSemanticQuery(sql, schema, {
            embedding,
            grep,
            meta,
            tree,
            temporal,
            limit,
          });
          results = rows.map(rowToSearchResult);
        } else {
          // Case 4: Filter-only (no search ranking)
          const rows = await buildFilterQuery(sql, schema, {
            grep,
            meta,
            tree,
            temporal,
            limit,
            orderBy,
          });
          results = rows.map(rowToSearchResult);
        }

        return {
          results,
          total: results.length,
          limit,
        };
      });
    },

    /**
     * Get the tree structure with counts
     */
    async getTree(params?: GetTreeParams): Promise<TreeNode[]> {
      const { tree: rootPath, levels } = params ?? {};

      return withTx(ctx, "read", "getTree", async (sql) => {
        if (rootPath) {
          const rows = await sql<TreeRow[]>`
            select subpath(tree, 0, nlevel(${rootPath}::ltree) + g.lvl)::text as path, count(*)::int as count
            from ${sql.unsafe(schema)}.memory
            cross join lateral generate_series(1, ${levels ?? 100}) as g(lvl)
            where tree <@ ${rootPath}::ltree
              and nlevel(tree) >= nlevel(${rootPath}::ltree) + g.lvl
            group by 1
            order by 1
          `;
          return rows.map((r) => ({ path: r.path, count: r.count }));
        }

        const rows = await sql<TreeRow[]>`
          select subpath(tree, 0, g.lvl)::text as path, count(*)::int as count
          from ${sql.unsafe(schema)}.memory
          cross join lateral generate_series(1, ${levels ?? 100}) as g(lvl)
          where nlevel(tree) >= g.lvl
            and tree <> ''::ltree
          group by 1
          order by 1
        `;
        return rows.map((r) => ({ path: r.path, count: r.count }));
      });
    },
  };
}

export type MemoryOps = ReturnType<typeof memoryOps>;

// Export for testing
export { detectTreeFilterType, rrfFusion };
