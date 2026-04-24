/**
 * Minimal type definitions for the memory engine RPC responses used by the
 * web UI. Mirrors `@memory.build/protocol` shapes but kept inline so the
 * browser build has no dependency on the workspace protocol package.
 *
 * If duplication grows past a handful of types, promote this to a
 * `@memory.build/protocol` import via a Vite resolver.
 */

export interface Temporal {
  start: string;
  end: string;
}

/**
 * A single memory returned by the engine.
 */
export interface Memory {
  id: string;
  content: string;
  meta: Record<string, unknown>;
  tree: string;
  temporal: Temporal | null;
  hasEmbedding: boolean;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string | null;
}

/**
 * A memory annotated with a search score.
 */
export interface MemoryWithScore extends Memory {
  score: number;
}

/**
 * Response shape for `memory.search`.
 */
export interface MemorySearchResult {
  results: MemoryWithScore[];
  total: number;
  limit: number;
}

/**
 * A node returned by `memory.tree`. Every distinct prefix of every memory's
 * tree appears as its own entry; `count` is the number of memories whose
 * tree starts with (or equals) this path. The server excludes memories
 * with empty trees, so root-level memories are counted separately via a
 * targeted `memory.search` call.
 */
export interface TreePathCountNode {
  path: string;
  count: number;
}

/**
 * Response shape for `memory.tree`.
 */
export interface MemoryTreeResult {
  nodes: TreePathCountNode[];
}

/**
 * Temporal filter shape for `memory.search`. The engine supports three
 * modes, each with its own shape:
 *
 *   { contains: "2026-04-01T00:00:00Z" }
 *   { overlaps: { start: "...", end: "..." } }
 *   { within:   { start: "...", end: "..." } }
 */
export type TemporalFilter =
  | { contains: string }
  | { overlaps: { start: string; end: string } }
  | { within: { start: string; end: string } };

/**
 * Parameters for `memory.search`. All fields optional — omitting everything
 * effectively "list all" via a wildcard tree filter.
 */
export interface MemorySearchParams {
  semantic?: string;
  fulltext?: string;
  grep?: string;
  tree?: string;
  meta?: Record<string, unknown>;
  temporal?: TemporalFilter;
  limit?: number;
  candidateLimit?: number;
  weights?: { semantic?: number; fulltext?: number };
  orderBy?: "asc" | "desc";
}

/**
 * Parameters for `memory.update`.
 */
export interface MemoryUpdateParams {
  id: string;
  content?: string | null;
  meta?: Record<string, unknown> | null;
  tree?: string | null;
  temporal?: Temporal | null;
}

export interface MemoryDeleteResult {
  deleted: boolean;
}

export interface MemoryDeleteTreeResult {
  count: number;
}
