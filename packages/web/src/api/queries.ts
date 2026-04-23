/**
 * TanStack Query hooks wrapping the JSON-RPC client.
 *
 * Query keys are derived from the input params, so changing a filter or id
 * naturally triggers a refetch and re-caches the result.
 */
import { type QueryClient, useMutation, useQuery } from "@tanstack/react-query";
import { rpc } from "./client.ts";
import type {
  Memory,
  MemoryDeleteResult,
  MemoryDeleteTreeResult,
  MemorySearchParams,
  MemorySearchResult,
  MemoryUpdateParams,
} from "./types.ts";

const SEARCH_LIMIT = 1000;

/**
 * Fetch memories matching the current filter. Empty filter effectively
 * lists everything via the `*` tree wildcard.
 */
export function useMemories(params: MemorySearchParams) {
  const normalized = normalizeSearchParams(params);
  return useQuery({
    queryKey: ["memories", normalized],
    queryFn: () => rpc<MemorySearchResult>("memory.search", normalized),
  });
}

/**
 * Fetch a single memory by id. Only needed when the search result hasn't
 * populated the memory yet (e.g., the URL-selected id is not in the
 * current filtered result set).
 */
export function useMemory(id: string | null) {
  return useQuery({
    enabled: id !== null,
    queryKey: ["memory", id],
    queryFn: () => rpc<Memory>("memory.get", { id: id as string }),
  });
}

/**
 * Update a memory's content / meta / tree / temporal.
 */
export function useUpdateMemory(queryClient: QueryClient) {
  return useMutation({
    mutationFn: (params: MemoryUpdateParams) =>
      rpc<Memory>("memory.update", params),
    onSuccess: (memory) => {
      queryClient.invalidateQueries({ queryKey: ["memories"] });
      queryClient.setQueryData(["memory", memory.id], memory);
    },
  });
}

/**
 * Delete a single memory by id.
 */
export function useDeleteMemory(queryClient: QueryClient) {
  return useMutation({
    mutationFn: (id: string) =>
      rpc<MemoryDeleteResult>("memory.delete", { id }),
    onSuccess: (_result, id) => {
      queryClient.invalidateQueries({ queryKey: ["memories"] });
      queryClient.removeQueries({ queryKey: ["memory", id] });
    },
  });
}

/**
 * Delete all memories under a tree path. Pass `dryRun: true` to just get
 * the count without mutating.
 */
export function useDeleteTree(queryClient: QueryClient) {
  return useMutation({
    mutationFn: (args: { tree: string; dryRun?: boolean }) =>
      rpc<MemoryDeleteTreeResult>("memory.deleteTree", args),
    onSuccess: (_result, args) => {
      if (!args.dryRun) {
        queryClient.invalidateQueries({ queryKey: ["memories"] });
      }
    },
  });
}

/**
 * Normalize search params for use as a query key and RPC body.
 *
 * - Drops empty strings / undefined so the query key is stable.
 * - If no filter criteria are supplied, defaults to `tree: "*"` to list
 *   everything (engine requires at least one criterion).
 * - Defaults limit to {@link SEARCH_LIMIT}.
 */
export function normalizeSearchParams(
  params: MemorySearchParams,
): MemorySearchParams {
  const out: MemorySearchParams = {};
  if (nonEmpty(params.semantic)) out.semantic = params.semantic;
  if (nonEmpty(params.fulltext)) out.fulltext = params.fulltext;
  if (nonEmpty(params.grep)) out.grep = params.grep;
  if (nonEmpty(params.tree)) out.tree = params.tree;
  if (params.meta && Object.keys(params.meta).length > 0)
    out.meta = params.meta;
  if (params.temporal) out.temporal = params.temporal;
  if (params.weights) out.weights = params.weights;
  if (params.orderBy) out.orderBy = params.orderBy;
  if (typeof params.candidateLimit === "number") {
    out.candidateLimit = params.candidateLimit;
  }

  const hasAnyFilter =
    out.semantic !== undefined ||
    out.fulltext !== undefined ||
    out.grep !== undefined ||
    out.tree !== undefined ||
    out.meta !== undefined ||
    out.temporal !== undefined;

  if (!hasAnyFilter) {
    out.tree = "*";
  }

  out.limit = typeof params.limit === "number" ? params.limit : SEARCH_LIMIT;
  return out;
}

function nonEmpty(s: string | undefined | null): s is string {
  return typeof s === "string" && s.length > 0;
}
