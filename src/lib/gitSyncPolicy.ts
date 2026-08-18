export type GitSyncAction =
  | "none"
  | "push"
  | "pull"
  | "pull-rebase-and-push";

export interface GitSyncPlan {
  action: GitSyncAction;
}

interface GitSyncState {
  ahead: number;
  behind: number;
}

/**
 * Let Git decide whether the working tree can safely be updated. Git permits
 * non-conflicting local changes and refuses operations that would overwrite
 * them, which is less restrictive than blocking every dirty worktree in the UI.
 */
export function getGitSyncPlan({
  ahead,
  behind,
}: GitSyncState): GitSyncPlan {
  const hasAhead = ahead > 0;
  const hasBehind = behind > 0;

  if (!hasAhead && !hasBehind) {
    return { action: "none" };
  }

  if (hasAhead && hasBehind) {
    return { action: "pull-rebase-and-push" };
  }

  if (hasBehind) {
    return { action: "pull" };
  }

  return { action: "push" };
}
