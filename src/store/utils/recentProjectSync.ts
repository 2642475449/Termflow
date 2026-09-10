import { projectPathKey } from "@/lib/openProjects";
import { RECENT_PROJECT_LIMIT, type RecentProjectEntry } from "./recentProjects";

export interface RecentProjectRecord {
  project: RecentProjectEntry;
  revision: number;
  removed: boolean;
}

// 保留删除标记，防止晚到的窗口快照恢复已删除记录。
export function mergeRecentProjectRecords(...snapshots: RecentProjectRecord[][]): RecentProjectRecord[] {
  const records = new Map<string, RecentProjectRecord>();
  for (const record of snapshots.flat()) {
    const key = projectPathKey(record.project.path);
    const previous = records.get(key);
    if (!previous || record.revision > previous.revision ||
      (record.revision === previous.revision && JSON.stringify(record) > JSON.stringify(previous))) {
      records.set(key, record);
    }
  }
  return [...records.values()].sort((a, b) => projectPathKey(a.project.path).localeCompare(projectPathKey(b.project.path)));
}

export function visibleRecentProjects(records: RecentProjectRecord[]): RecentProjectEntry[] {
  return records.filter((record) => !record.removed).map((record) => record.project)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || projectPathKey(a.path).localeCompare(projectPathKey(b.path)))
    .slice(0, RECENT_PROJECT_LIMIT);
}
