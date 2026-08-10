export type GitSyncAction =
  | "none"
  | "push"
  | "pull"
  | "pull-rebase-and-push";

export interface GitSyncPlan {
  action: GitSyncAction;
  blockedByLocalChanges: boolean;
}

interface GitSyncState {
  ahead: number;
  behind: number;
  hasLocalChanges: boolean;
}

/**
 * Keep sync behavior predictable and avoid touching a dirty worktree when a
 * pull (including a rebase pull) is required. Pushing existing commits does
 * not read or modify unstaged/staged working tree changes, so it remains safe.
 */
export function getGitSyncPlan({
  ahead,
  behind,
  hasLocalChanges,
}: GitSyncState): GitSyncPlan {
  const hasAhead = ahead > 0;
  const hasBehind = behind > 0;

  if (!hasAhead && !hasBehind) {
    return { action: "none", blockedByLocalChanges: false };
  }

  if (hasBehind && hasLocalChanges) {
    return { action: "none", blockedByLocalChanges: true };
  }

  if (hasAhead && hasBehind) {
    return {
      action: "pull-rebase-and-push",
      blockedByLocalChanges: false,
    };
  }

  if (hasBehind) {
    return { action: "pull", blockedByLocalChanges: false };
  }

  return { action: "push", blockedByLocalChanges: false };
}
