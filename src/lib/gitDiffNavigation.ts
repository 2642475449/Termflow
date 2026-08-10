export type DiffNavigationDirection = "previous" | "next";

export interface DiffLineRange {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

export interface GitHunkLineRange {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export function getAdjacentDiffIndex(
  currentIndex: number,
  changeCount: number,
  direction: DiffNavigationDirection,
) {
  if (changeCount <= 0) return -1;
  const normalizedIndex = Math.min(Math.max(currentIndex, 0), changeCount - 1);
  return direction === "previous"
    ? Math.max(0, normalizedIndex - 1)
    : Math.min(changeCount - 1, normalizedIndex + 1);
}

export function getModifiedDiffTargetLine(change: DiffLineRange) {
  if (change.modifiedStartLineNumber > 0) return change.modifiedStartLineNumber;
  if (change.modifiedEndLineNumber > 0) return change.modifiedEndLineNumber;
  if (change.originalStartLineNumber > 0) return change.originalStartLineNumber;
  return Math.max(1, change.originalEndLineNumber);
}

function distanceToRange(line: number, start: number, lineCount: number) {
  const normalizedStart = Math.max(1, start);
  const end = normalizedStart + Math.max(1, lineCount) - 1;
  if (line < normalizedStart) return normalizedStart - line;
  if (line > end) return line - end;
  return 0;
}

export function findClosestGitHunkIndex(
  change: DiffLineRange,
  hunks: GitHunkLineRange[],
) {
  if (hunks.length === 0) return -1;

  const modifiedLine = getModifiedDiffTargetLine(change);
  const originalLine = change.originalStartLineNumber > 0
    ? change.originalStartLineNumber
    : Math.max(1, change.originalEndLineNumber);

  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  hunks.forEach((hunk, index) => {
    const distance = Math.min(
      distanceToRange(modifiedLine, hunk.newStart, hunk.newLines),
      distanceToRange(originalLine, hunk.oldStart, hunk.oldLines),
    );
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  });

  return closestIndex;
}
