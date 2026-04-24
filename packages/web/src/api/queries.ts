/**
 * TanStack Query hooks wrapping the JSON-RPC client.
 *
 * Query keys are derived from the input params, so changing a filter or id
 * naturally triggers a refetch and re-caches the result.
 */

import type {
  MemorySearchParams,
  MemoryUpdateParams,
} from "@memory.build/client";
import { type QueryClient, useMutation, useQuery } from "@tanstack/react-query";
import { memoryEngineClient } from "./client.ts";

const SEARCH_LIMIT = 1000;

/**
 * Convert an exact ltree path to an lquery pattern that matches only that
 * path (no descendants). The engine's tree filter auto-detects lquery vs
 * ltree by special characters; by duplicating the last label via `|` or
 * using the zero-label quantifier for the empty path, we force lquery
 * detection while preserving exact-match semantics.
 *
 * Examples:
 *   ""               -> "*{0,0}"          matches only the empty tree
 *   "work"           -> "work|work"       matches only `work`
 *   "work.projects"  -> "work.projects|projects" matches only `work.projects`
 */
export function exactTreeLquery(path: string): string {
  if (path === "") return "*{0,0}";
  const labels = path.split(".");
  const i = labels.length - 1;
  labels[i] = `${labels[i]}|${labels[i]}`;
  return labels.join(".");
}

/**
 * Fetch memories matching the current filter. When `enabled` is false the
 * query is suspended (used by the tree view to skip search-mode fetches
 * while in browse mode).
 */
export function useMemories(params: MemorySearchParams, enabled = true) {
  const normalized = normalizeSearchParams(params);
  return useQuery({
    enabled,
    queryKey: ["memories", normalized],
    queryFn: () => memoryEngineClient.memory.search(normalized),
  });
}

/**
 * Fetch the full tree structure — every path segment across every memory
 * with an aggregate count. Cheap: no content, no memory content rows.
 *
 * This is the source of truth for the navigation tree's path nodes.
 */
export function useTree() {
  return useQuery({
    queryKey: ["memory-tree"],
    queryFn: () => memoryEngineClient.memory.tree(),
  });
}

/**
 * Fetch the memories living at an exact tree path (not its descendants).
 *
 * The query is gated by `enabled` so we only pay the fetch cost when the
 * caller actually needs the leaves — typically when the user expands a
 * path node. Empty path (`""`) returns memories with no tree set.
 */
export function useMemoriesAtExactPath(path: string, enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ["memories-at-exact-path", path],
    queryFn: () =>
      memoryEngineClient.memory.search({
        tree: exactTreeLquery(path),
        limit: SEARCH_LIMIT,
      }),
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
    queryFn: () => memoryEngineClient.memory.get({ id: id as string }),
  });
}

/**
 * Update a memory's content / meta / tree / temporal.
 */
export function useUpdateMemory(queryClient: QueryClient) {
  return useMutation({
    mutationFn: (params: MemoryUpdateParams) =>
      memoryEngineClient.memory.update(params),
    onSuccess: (memory) => {
      invalidateTreeQueries(queryClient);
      queryClient.setQueryData(["memory", memory.id], memory);
    },
  });
}

/**
 * Delete a single memory by id.
 */
export function useDeleteMemory(queryClient: QueryClient) {
  return useMutation({
    mutationFn: (id: string) => memoryEngineClient.memory.delete({ id }),
    onSuccess: (_result, id) => {
      invalidateTreeQueries(queryClient);
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
      memoryEngineClient.memory.deleteTree(args),
    onSuccess: (_result, args) => {
      if (!args.dryRun) {
        invalidateTreeQueries(queryClient);
      }
    },
  });
}

/**
 * Invalidate every cached query that could have changed after a memory
 * mutation: the path hierarchy, any per-path leaf lists, and the legacy
 * flat search list.
 */
function invalidateTreeQueries(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ["memory-tree"] });
  queryClient.invalidateQueries({ queryKey: ["memories-at-exact-path"] });
  queryClient.invalidateQueries({ queryKey: ["memories"] });
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
