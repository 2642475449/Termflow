export const GIT_GRAPH_REFRESH_EVENT = "termflow:git-graph-refresh";
export const GIT_FILE_HISTORY_OPEN_EVENT = "termflow:git-file-history-open";

export interface GitGraphRefreshDetail {
  projectPath: string;
}

export interface GitFileHistoryOpenDetail {
  projectPath: string;
  filePath: string;
}

let pendingFileHistoryRequest: GitFileHistoryOpenDetail | null = null;

function normalizeProjectPath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function dispatchGitFileHistoryOpen(detail: GitFileHistoryOpenDetail) {
  pendingFileHistoryRequest = detail;
  window.dispatchEvent(
    new CustomEvent<GitFileHistoryOpenDetail>(GIT_FILE_HISTORY_OPEN_EVENT, { detail }),
  );
}

export function takePendingGitFileHistoryOpen(projectPath: string) {
  if (
    !pendingFileHistoryRequest
    || normalizeProjectPath(pendingFileHistoryRequest.projectPath) !== normalizeProjectPath(projectPath)
  ) {
    return null;
  }

  const request = pendingFileHistoryRequest;
  pendingFileHistoryRequest = null;
  return request;
}

export function dispatchGitGraphRefresh(projectPath: string) {
  window.dispatchEvent(
    new CustomEvent<GitGraphRefreshDetail>(GIT_GRAPH_REFRESH_EVENT, {
      detail: { projectPath },
    }),
  );
}

export async function refreshGitStateAndGraph(
  projectPath: string,
  refreshGitState: () => Promise<void>,
) {
  try {
    await refreshGitState();
  } finally {
    dispatchGitGraphRefresh(projectPath);
  }
}

export function shouldReloadGitGraphOnExpand(
  wasCollapsed: boolean,
  collapsed: boolean,
  initialized: boolean,
) {
  return wasCollapsed && !collapsed && initialized;
}
