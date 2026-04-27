export const MIN_SEARCH_RESULTS_HEIGHT = 120;
export const DEFAULT_SEARCH_RESULTS_HEIGHT = 240;
export const MIN_TREE_PANE_HEIGHT = 140;
export const SEARCH_RESULTS_RESIZER_HEIGHT = 4;

export function clampSearchResultsHeight(height: number): number {
  if (!Number.isFinite(height)) return DEFAULT_SEARCH_RESULTS_HEIGHT;
  if (height < MIN_SEARCH_RESULTS_HEIGHT) return MIN_SEARCH_RESULTS_HEIGHT;
  return Math.round(height);
}

export function maxSearchResultsHeightForContainer(
  containerHeight: number | null | undefined,
): number | null {
  if (!containerHeight || !Number.isFinite(containerHeight)) return null;
  return Math.max(
    MIN_SEARCH_RESULTS_HEIGHT,
    Math.round(
      containerHeight - MIN_TREE_PANE_HEIGHT - SEARCH_RESULTS_RESIZER_HEIGHT,
    ),
  );
}

export function clampSearchResultsHeightToContainer(
  height: number,
  containerHeight: number | null | undefined,
): number {
  const minClampedHeight = clampSearchResultsHeight(height);
  const maxHeight = maxSearchResultsHeightForContainer(containerHeight);
  return maxHeight === null
    ? minClampedHeight
    : Math.min(minClampedHeight, maxHeight);
}
