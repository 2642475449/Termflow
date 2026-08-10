export const GIT_GRAPH_REFRESH_EVENT = "termflow:git-graph-refresh";

export interface GitGraphRefreshDetail {
  projectPath: string;
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
