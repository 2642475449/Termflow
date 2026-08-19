import type { GitGraphCommit } from "@/types";

/**
 * File history hides commits that did not touch the selected file. Reconnect
 * each visible commit to the next visible one so the graph keeps one lane
 * instead of treating gaps in repository history as new branches.
 */
export function linearizeFileHistoryCommits(
  commits: GitGraphCommit[],
): GitGraphCommit[] {
  return commits.map((commit, index) => ({
    ...commit,
    parentOids: commits[index + 1] ? [commits[index + 1].oid] : [],
  }));
}
