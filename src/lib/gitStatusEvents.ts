import type { GitBranchInfo, GitFileStatus } from "@/types";

export const GIT_STATUS_SNAPSHOT_EVENT = "termflow:git-status-snapshot";
export const GIT_REFRESH_EVENT = "termflow:git-refresh";

export interface GitStatusSnapshot {
  /** 同一项目内单调递增的快照版本，防止慢请求覆盖更新结果。 */
  generation: number;
  projectPath: string;
  isRepo: boolean;
  statuses: GitFileStatus[];
  branch: GitBranchInfo | null;
}

export function publishGitStatusSnapshot(snapshot: GitStatusSnapshot) {
  window.dispatchEvent(new CustomEvent<GitStatusSnapshot>(GIT_STATUS_SNAPSHOT_EVENT, { detail: snapshot }));
}

export function requestGitStatusRefresh(projectPath: string) {
  window.dispatchEvent(new CustomEvent(GIT_REFRESH_EVENT, { detail: { projectPath } }));
}
