export const DEFAULT_GLOBAL_SEARCH_SPLIT_RATIO = 42;
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
  clientX: number,
  containerLeft: number,
  containerWidth: number,
): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return DEFAULT_GLOBAL_SEARCH_SPLIT_RATIO;
  }
  return clampGlobalSearchSplitRatio(
    ((clientX - containerLeft) / containerWidth) * 100,
  );
}

export interface SearchWindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function adjustSearchWindow(
  bounds: SearchWindowBounds,
  direction: string,
  dx: number,
  dy: number,
  viewportWidth: number,
  viewportHeight: number,
): SearchWindowBounds {
  const margin = 8;
  const maxWidth = Math.max(1, viewportWidth - margin * 2);
  const maxHeight = Math.max(1, viewportHeight - margin * 2);
  const minWidth = Math.min(640, maxWidth);
  const minHeight = Math.min(360, maxHeight);
  const width = Math.min(bounds.width, maxWidth);
  const height = Math.min(bounds.height, maxHeight);
  const left = Math.max(margin, Math.min(bounds.left, viewportWidth - margin - width));
  const top = Math.max(margin, Math.min(bounds.top, viewportHeight - margin - height));
  if (direction === "move") {
    return { width, height,
      left: Math.max(margin, Math.min(left + dx, viewportWidth - margin - width)),
      top: Math.max(margin, Math.min(top + dy, viewportHeight - margin - height)),
    };
  }
  let right = left + width;
  let bottom = top + height;
  let nextLeft = left;
  let nextTop = top;
  if (direction.includes("e")) right = Math.max(left + minWidth, Math.min(viewportWidth - margin, right + dx));
  if (direction.includes("s")) bottom = Math.max(top + minHeight, Math.min(viewportHeight - margin, bottom + dy));
  if (direction.includes("w")) nextLeft = Math.max(margin, Math.min(right - minWidth, left + dx));
  if (direction.includes("n")) nextTop = Math.max(margin, Math.min(bottom - minHeight, top + dy));
  return { left: nextLeft, top: nextTop, width: right - nextLeft, height: bottom - nextTop };
}
