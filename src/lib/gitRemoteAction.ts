import type { GitBranchInfo } from "@/types";

export interface GitRemoteState {
  remotes: { name: string; url: string }[];
  upstream: string | null;
  hasCommit: boolean;
  branches: string[];
  branchName: string | null;
  requiresFetch: boolean;
}

export function getGitRemoteAction(
  state: GitRemoteState | null,
  branch: GitBranchInfo | null,
) {
  if (!state || !branch) return "retry";
  if (state.hasCommit && state.branchName !== branch.branchName) return "retry";
  if (state.remotes.length === 0) return "add";
  if (state.requiresFetch) return "fetch";
  if (branch.isDetached || !state.hasCommit) return "fetch";
  if (!state.upstream) return "publish";
  if (branch.ahead > 0 && branch.behind > 0) return "sync";
  if (branch.ahead > 0) return "push";
  if (branch.behind > 0) return "pull";
  return "fetch";
}
