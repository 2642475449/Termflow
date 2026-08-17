import type { GitCloneTask, ProjectSearchIndexStatus } from "@/types";

const VISIBLE_INDEX_STATES = new Set<ProjectSearchIndexStatus["state"]>([
  "preflight",
  "building",
  "updating",
  "stale",
  "failed",
  "unsupported",
]);

export interface BackgroundTaskSummary {
  cloneCount: number;
  indexVisible: boolean;
  totalCount: number;
  concurrent: boolean;
  indexProgressPercent: number | null;
}

export function getIndexProgressPercent(
  status: ProjectSearchIndexStatus | null,
): number | null {
  if (!status?.totalFiles || status.totalFiles <= 0) return null;
  return Math.min(100, Math.max(0, Math.round(
    (status.processedFiles / status.totalFiles) * 100,
  )));
}

export function summarizeBackgroundTasks(
  cloneTasks: GitCloneTask[],
  indexStatus: ProjectSearchIndexStatus | null,
  indexStatusError: string | null,
): BackgroundTaskSummary {
  const indexVisible = Boolean(indexStatusError)
    || Boolean(indexStatus?.enabled && VISIBLE_INDEX_STATES.has(indexStatus.state));
  const cloneCount = cloneTasks.length;

  return {
    cloneCount,
    indexVisible,
    totalCount: cloneCount + (indexVisible ? 1 : 0),
    concurrent: cloneCount > 0 && indexVisible,
    indexProgressPercent: getIndexProgressPercent(indexStatus),
  };
}
