import type { Sql } from "postgres";
import type { AccessLevel } from "../core/types";
import type {
  CreateMemoryParams,
  HybridSearchOptions,
  Memory,
  MemoryPatch,
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
  createMemory(
    treeAccess: TreeAccess,
    params: CreateMemoryParams,
  ): Promise<string>;
  getMemory(treeAccess: TreeAccess, id: string): Promise<Memory | null>;
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
        select ${sch}.create_memory(
          ${jb(treeAccess)},
          ${p.tree}::ltree,
          ${p.content},
          ${p.id ?? null},
          ${jb(p.meta)},
          ${p.temporal ?? null}::tstzrange
        ) as id`;
      if (!row) throw new Error("create_memory returned no row");
      return row.id as string;
    },

    async getMemory(treeAccess, id) {
      const [row] = await sql`
        select id, tree::text as tree, meta, temporal::text as temporal,
               content, has_embedding, created_at, updated_at
        from ${sch}.get_memory(${jb(treeAccess)}, ${id})`;
      return row ? mapMemory(row) : null;
    },

    async patchMemory(treeAccess, id, patch) {
      const obj: Record<string, unknown> = {};
      if (patch.tree !== undefined) obj.tree = patch.tree;
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

    async countTree(treeAccess, query, access) {
      let row: { n?: unknown } | undefined;
      if (query.tree !== undefined) {
        [row] = await sql`
          select ${sch}.count_tree(${jb(treeAccess)}, ${query.tree}::ltree, ${access}) as n`;
      } else if (query.lquery !== undefined) {
        [row] = await sql`
          select ${sch}.count_tree(${jb(treeAccess)}, ${query.lquery}::lquery, ${access}) as n`;
      } else if (query.ltxtquery !== undefined) {
        [row] = await sql`
          select ${sch}.count_tree(${jb(treeAccess)}, ${query.ltxtquery}::ltxtquery, ${access}) as n`;
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
               content, has_embedding, created_at, updated_at, score
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
          ${o.limit ?? 10}
        )`;
      return rows.map(mapSearchItem);
    },

    async hybridSearch(treeAccess, options) {
      const o = options;
      const rows = await sql`
        select id, meta, tree::text as tree, temporal::text as temporal,
               content, has_embedding, created_at, updated_at, score
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
