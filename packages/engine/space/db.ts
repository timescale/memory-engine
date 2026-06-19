import type { Sql } from "postgres";
import type { AccessLevel } from "../core/types";
import type {
  CreateMemoryParams,
  HybridSearchOptions,
  Memory,
  MemoryPatch,
  OnConflict,
  SearchOptions,
  SearchResultItem,
  TreeAccess,
  TreeListEntry,
} from "./types";

/**
 * The space data-plane layer for one space schema (me_<slug>).
 *
 * Thin wrappers over the space SQL functions — each method calls a function and
 * passes the `treeAccess` set (from core.buildTreeAccess) for access enforcement.
 * No table queries in TS; no RLS (access is the jsonb argument).
 */
export interface SpaceStore {
  /**
   * Insert one memory. When an explicit `params.id` already exists the
   * outcome depends on `params.replaceIfMetaDiffers`: unset → skip (null);
   * set to a meta key → the existing row is replaced when its value for that
   * key differs from the new record's (`inserted: false`), else skipped.
   * Deterministic-id importers use this to re-submit idempotently and push
   * version-bump re-renders in the same call.
   */
  createMemory(
    treeAccess: TreeAccess,
    params: CreateMemoryParams,
  ): Promise<{ id: string; inserted: boolean } | null>;
  /**
   * Set-based createMemory for a whole batch: one statement, one round
   * trip, same per-row conflict semantics. Returns one row per
   * insert/replace — skipped rows are absent — and an explicit id repeated
   * within the batch collapses to its first occurrence. Atomic.
   */
  batchCreateMemories(
    treeAccess: TreeAccess,
    memories: CreateMemoryParams[],
    replaceIfMetaDiffers?: string,
    onConflict?: OnConflict,
  ): Promise<Array<{ id: string; inserted: boolean }>>;
  getMemory(treeAccess: TreeAccess, id: string): Promise<Memory | null>;
  /** Resolve a (tree, name) reference to its memory id (read-gated), or null. */
  resolveMemoryId(
    treeAccess: TreeAccess,
    tree: string,
    name: string,
  ): Promise<string | null>;
  patchMemory(
    treeAccess: TreeAccess,
    id: string,
    patch: MemoryPatch,
  ): Promise<boolean>;
  deleteMemory(treeAccess: TreeAccess, id: string): Promise<boolean>;

  moveTree(
    treeAccess: TreeAccess,
    src: string,
    dst: string,
    dryRun?: boolean,
  ): Promise<number>;
  copyTree(
    treeAccess: TreeAccess,
    src: string,
    dst: string,
    dryRun?: boolean,
  ): Promise<number>;
  deleteTree(
    treeAccess: TreeAccess,
    tree: string,
    dryRun?: boolean,
  ): Promise<number>;
  countTree(
    treeAccess: TreeAccess,
    query: { tree?: string; lquery?: string; ltxtquery?: string },
    access: AccessLevel,
    maxCount?: number,
  ): Promise<number>;
  listTree(treeAccess: TreeAccess, lquery: string): Promise<TreeListEntry[]>;

  search(
    treeAccess: TreeAccess,
    options?: SearchOptions,
  ): Promise<SearchResultItem[]>;
  hybridSearch(
    treeAccess: TreeAccess,
    options: HybridSearchOptions,
  ): Promise<SearchResultItem[]>;

  /** Run operations atomically against the same transaction. */
  withTransaction<T>(fn: (store: SpaceStore) => Promise<T>): Promise<T>;
}

function mapMemory(row: Record<string, unknown>): Memory {
  return {
    id: row.id as string,
    tree: row.tree as string,
    name: (row.name as string | null) ?? null,
    meta: (row.meta as Record<string, unknown>) ?? {},
    temporal: (row.temporal as string | null) ?? null,
    content: row.content as string,
    hasEmbedding: Boolean(row.has_embedding),
    createdAt: row.created_at as Date,
    updatedAt: (row.updated_at as Date | null) ?? null,
  };
}

function mapSearchItem(row: Record<string, unknown>): SearchResultItem {
  return { ...mapMemory(row), score: Number(row.score) };
}

export function spaceStore(sql: Sql, schema: string): SpaceStore {
  const sch = sql(schema);
  const bm25Index = `${schema}.memory_content_bm25_idx`;

  /**
   * jsonb param fragment (null-safe). Uses sql.json so postgres.js serializes
   * the value as json — passing a pre-stringified string double-encodes it into
   * a jsonb string scalar, and passing a raw JS array would be sent as a Postgres
   * array; both break jsonb_to_recordset in the SQL functions.
   */
  const jb = (v: unknown) =>
    v === null || v === undefined
      ? sql`null::jsonb`
      : sql`${sql.json(v as never)}::jsonb`;

  /** bm25query fragment from a query string (or null). */
  const bm25 = (q: string | undefined) =>
    q === undefined
      ? sql`null::bm25query`
      : sql`to_bm25query(${q}::text, ${bm25Index}::text)`;

  /** halfvec fragment from an embedding (or null). */
  const halfvec = (v: number[] | undefined) =>
    v === undefined ? sql`null::halfvec` : sql`${`[${v.join(",")}]`}::halfvec`;

  return {
    async createMemory(treeAccess, p) {
      const [row] = await sql`
        select id, inserted from ${sch}.create_memory(
          ${jb(treeAccess)},
          ${p.tree}::ltree,
          ${p.content},
          ${p.id ?? null},
          ${jb(p.meta)},
          ${p.temporal ?? null}::tstzrange,
          ${p.replaceIfMetaDiffers ?? null},
          ${p.name ?? null},
          ${p.onConflict ?? "error"}
        )`;
      // Zero rows = the conflict was skipped: onConflict 'ignore', a 'replace'
      // no-op, or a replaceIfMetaDiffers/version match. ('error' raises.)
      if (!row) return null;
      return { id: row.id as string, inserted: Boolean(row.inserted) };
    },

    async batchCreateMemories(
      treeAccess,
      memories,
      replaceIfMetaDiffers,
      onConflict,
    ) {
      if (memories.length === 0) return [];
      // Parallel arrays aligned by position. Metas travel as ONE jsonb array
      // via sql.json — a jsonb[] parameter would double-encode each element
      // into a string scalar (see the jb() note above).
      const rows = await sql`
        select id, inserted from ${sch}.batch_create_memory(
          ${jb(treeAccess)},
          ${memories.map((m) => m.id ?? null)}::uuid[],
          ${memories.map((m) => m.tree)}::ltree[],
          ${memories.map((m) => m.content)}::text[],
          ${jb(memories.map((m) => m.meta ?? {}))},
          ${memories.map((m) => m.temporal ?? null)}::tstzrange[],
          ${replaceIfMetaDiffers ?? null},
          ${memories.map((m) => m.name ?? null)}::text[],
          ${onConflict ?? "error"}
        )`;
      return rows.map((r) => ({
        id: r.id as string,
        inserted: Boolean(r.inserted),
      }));
    },

    async getMemory(treeAccess, id) {
      const [row] = await sql`
        select id, tree::text as tree, name, meta, temporal::text as temporal,
               content, has_embedding, created_at, updated_at
        from ${sch}.get_memory(${jb(treeAccess)}, ${id})`;
      return row ? mapMemory(row) : null;
    },

    async resolveMemoryId(treeAccess, tree, name) {
      const [row] = await sql`
        select ${sch}.resolve_memory_id(${jb(treeAccess)}, ${tree}::ltree, ${name}) as id`;
      return (row?.id as string | null) ?? null;
    },

    async patchMemory(treeAccess, id, patch) {
      const obj: Record<string, unknown> = {};
      if (patch.tree !== undefined) obj.tree = patch.tree;
      if (patch.name !== undefined) obj.name = patch.name; // null clears it
      if (patch.meta !== undefined) obj.meta = patch.meta;
      if (patch.temporal !== undefined) obj.temporal = patch.temporal;
      if (patch.content !== undefined) obj.content = patch.content;
      const [row] = await sql`
        select ${sch}.patch_memory(${jb(treeAccess)}, ${id}, ${jb(obj)}) as ok`;
      return Boolean(row?.ok);
    },

    async deleteMemory(treeAccess, id) {
      const [row] = await sql`
        select ${sch}.delete_memory(${jb(treeAccess)}, ${id}) as ok`;
      return Boolean(row?.ok);
    },

    async moveTree(treeAccess, src, dst, dryRun = false) {
      const [row] = await sql`
        select ${sch}.move_tree(${jb(treeAccess)}, ${src}::ltree, ${dst}::ltree, ${dryRun}) as n`;
      return Number(row?.n);
    },

    async copyTree(treeAccess, src, dst, dryRun = false) {
      const [row] = await sql`
        select ${sch}.copy_tree(${jb(treeAccess)}, ${src}::ltree, ${dst}::ltree, ${dryRun}) as n`;
      return Number(row?.n);
    },

    async deleteTree(treeAccess, tree, dryRun = false) {
      const [row] = await sql`
        select ${sch}.delete_tree(${jb(treeAccess)}, ${tree}::ltree, ${dryRun}) as n`;
      return Number(row?.n);
    },

    async countTree(treeAccess, query, access, maxCount) {
      let row: { n?: unknown } | undefined;
      if (query.tree !== undefined) {
        [row] = await sql`
          select ${sch}.count_tree(${jb(treeAccess)}, ${query.tree}::ltree, ${access}, ${maxCount ?? null}) as n`;
      } else if (query.lquery !== undefined) {
        [row] = await sql`
          select ${sch}.count_tree(${jb(treeAccess)}, ${query.lquery}::lquery, ${access}, ${maxCount ?? null}) as n`;
      } else if (query.ltxtquery !== undefined) {
        [row] = await sql`
          select ${sch}.count_tree(${jb(treeAccess)}, ${query.ltxtquery}::ltxtquery, ${access}, ${maxCount ?? null}) as n`;
      } else {
        throw new Error("countTree requires one of tree / lquery / ltxtquery");
      }
      return Number(row?.n);
    },

    async listTree(treeAccess, lquery) {
      const rows = await sql`
        select tree::text as tree, count
        from ${sch}.list_tree(${jb(treeAccess)}, ${lquery}::lquery)`;
      return rows.map((r) => ({
        tree: r.tree as string,
        count: Number(r.count),
      }));
    },

    async search(treeAccess, options = {}) {
      const o = options;
      const rows = await sql`
        select id, meta, tree::text as tree, temporal::text as temporal,
               content, name, has_embedding, created_at, updated_at, score
        from ${sch}.search_memory(
          ${jb(treeAccess)},
          ${bm25(o.bm25)},
          ${halfvec(o.vec)},
          ${o.maxVecDist ?? null},
          ${o.ltree ?? null}::ltree,
          ${o.lquery ?? null}::lquery,
          ${o.ltxtquery ?? null}::ltxtquery,
          ${jb(o.metaContains)},
          ${o.temporalWithin ?? null}::tstzrange,
          ${o.temporalOverlaps ?? null}::tstzrange,
          ${o.temporalBefore ?? null}::timestamptz,
          ${o.temporalAfter ?? null}::timestamptz,
          ${o.regexp ?? null},
          ${o.limit ?? 10},
          ${o.order ?? "desc"}
        )`;
      return rows.map(mapSearchItem);
    },

    async hybridSearch(treeAccess, options) {
      const o = options;
      const rows = await sql`
        select id, meta, tree::text as tree, temporal::text as temporal,
               content, name, has_embedding, created_at, updated_at, score
        from ${sch}.hybrid_search_memory(
          ${jb(treeAccess)},
          ${bm25(o.bm25)},
          ${halfvec(o.vec)},
          ${o.maxVecDist ?? null},
          ${o.ltree ?? null}::ltree,
          ${o.lquery ?? null}::lquery,
          ${o.ltxtquery ?? null}::ltxtquery,
          ${jb(o.metaContains)},
          ${o.temporalWithin ?? null}::tstzrange,
          ${o.temporalOverlaps ?? null}::tstzrange,
          ${o.temporalBefore ?? null}::timestamptz,
          ${o.temporalAfter ?? null}::timestamptz,
          ${o.regexp ?? null},
          ${o.k ?? 60.0},
          ${o.candidateLimit ?? 30},
          ${o.fulltextWeight ?? 1.0},
          ${o.semanticWeight ?? 1.0},
          ${o.limit ?? 10}
        )`;
      return rows.map(mapSearchItem);
    },

    async withTransaction<T>(
      fn: (store: SpaceStore) => Promise<T>,
    ): Promise<T> {
      return sql.begin((tx) =>
        fn(spaceStore(tx as unknown as Sql, schema)),
      ) as Promise<T>;
    },
  };
}
