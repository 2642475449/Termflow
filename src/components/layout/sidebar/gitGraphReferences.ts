import type { GitGraphRef } from "@/types";

const WORKTREE_BRANCH_PREFIX = "worktree-";

/**
 * Worktree branches are transient and often accumulate on the same commit.
 * Keep them distinct from normal branches so callers can present them without
 * turning a commit row (or its hover card) into a wall of tags.
 */
export function isWorktreeBranchRef(ref: GitGraphRef): boolean {
  return ref.kind === "branch" && ref.name.startsWith(WORKTREE_BRANCH_PREFIX);
}

export function splitWorktreeReferences(refs: GitGraphRef[]): {
  regular: GitGraphRef[];
  worktrees: GitGraphRef[];
} {
  const regular: GitGraphRef[] = [];
  const worktrees: GitGraphRef[] = [];

  for (const ref of refs) {
    if (isWorktreeBranchRef(ref)) {
      worktrees.push(ref);
    } else {
      regular.push(ref);
    }
  }

  return { regular, worktrees };
}
