export interface VirtualRange {
  start: number;
  end: number;
}

export function getVirtualRange(
  itemCount: number,
  itemHeight: number,
  visibleTop: number,
  visibleBottom: number,
  overscan: number,
): VirtualRange {
  if (itemCount <= 0 || itemHeight <= 0) {
    return { start: 0, end: 0 };
  }

  const start = Math.min(
    itemCount,
    Math.max(0, Math.floor(visibleTop / itemHeight) - overscan),
  );
  const end = Math.min(
    itemCount,
    Math.ceil(Math.max(visibleTop, visibleBottom) / itemHeight) + overscan,
  );

  return { start, end: Math.max(start, end) };
}
