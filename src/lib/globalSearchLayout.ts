export const DEFAULT_GLOBAL_SEARCH_SPLIT_RATIO = 55;
export const MIN_GLOBAL_SEARCH_SPLIT_RATIO = 20;
export const MAX_GLOBAL_SEARCH_SPLIT_RATIO = 80;

export function clampGlobalSearchSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_GLOBAL_SEARCH_SPLIT_RATIO;
  return Math.min(
    MAX_GLOBAL_SEARCH_SPLIT_RATIO,
    Math.max(MIN_GLOBAL_SEARCH_SPLIT_RATIO, value),
  );
}

export function globalSearchSplitRatioFromPointer(
  clientY: number,
  containerTop: number,
  containerHeight: number,
): number {
  if (!Number.isFinite(containerHeight) || containerHeight <= 0) {
    return DEFAULT_GLOBAL_SEARCH_SPLIT_RATIO;
  }
  return clampGlobalSearchSplitRatio(
    ((clientY - containerTop) / containerHeight) * 100,
  );
}
