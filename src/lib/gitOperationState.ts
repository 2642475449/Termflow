import type { GitRepositoryOperationState } from "@/types";

type TranslationKey =
  | "sidebar.gitOperationMerge"
  | "sidebar.gitOperationRebase"
  | "sidebar.gitOperationCherryPick"
  | "sidebar.gitOperationRevert"
  | "sidebar.gitOperationBisect"
  | "sidebar.gitOperationApplyMailbox"
  | "sidebar.gitOperationUnknown";

/** Whether normal commit, pull and sync actions are safe to offer. */
export function isGitOperationInProgress(
  operationState: GitRepositoryOperationState | null | undefined,
): boolean {
  return !!operationState && operationState !== "clean";
}

/** Map backend operation states to user-facing operation names. */
export function getGitOperationLabelKey(
  operationState: GitRepositoryOperationState | null | undefined,
): TranslationKey {
  switch (operationState) {
    case "merge":
      return "sidebar.gitOperationMerge";
    case "rebase":
    case "rebase-interactive":
    case "rebase-merge":
      return "sidebar.gitOperationRebase";
    case "cherry-pick":
    case "cherry-pick-sequence":
      return "sidebar.gitOperationCherryPick";
    case "revert":
    case "revert-sequence":
      return "sidebar.gitOperationRevert";
    case "bisect":
      return "sidebar.gitOperationBisect";
    case "apply-mailbox":
    case "apply-mailbox-or-rebase":
      return "sidebar.gitOperationApplyMailbox";
    case "clean":
    case undefined:
    case null:
      return "sidebar.gitOperationUnknown";
  }
}

/** Git provides a direct --abort command for these in-progress operations. */
export function canAbortGitOperation(
  operationState: GitRepositoryOperationState | null | undefined,
): boolean {
  return (
    operationState === "merge"
    || operationState === "rebase"
    || operationState === "rebase-interactive"
    || operationState === "rebase-merge"
    || operationState === "cherry-pick"
    || operationState === "cherry-pick-sequence"
    || operationState === "revert"
    || operationState === "revert-sequence"
  );
}

/** The desktop UI can continue the same set of sequencer operations it can abort. */
export function canContinueGitOperation(
  operationState: GitRepositoryOperationState | null | undefined,
): boolean {
  return canAbortGitOperation(operationState);
}

/** During a rebase, Git's ours/theirs terminology has the opposite direction. */
export function getGitConflictResolutionLabelKeys(
  operationState: GitRepositoryOperationState | null | undefined,
): {
  ours: "sidebar.gitResolveOurs" | "sidebar.gitResolveOursRebase";
  theirs: "sidebar.gitResolveTheirs" | "sidebar.gitResolveTheirsRebase";
} {
  const isRebase =
    operationState === "rebase"
    || operationState === "rebase-interactive"
    || operationState === "rebase-merge";
  return isRebase
    ? {
        ours: "sidebar.gitResolveOursRebase",
        theirs: "sidebar.gitResolveTheirsRebase",
      }
    : {
        ours: "sidebar.gitResolveOurs",
        theirs: "sidebar.gitResolveTheirs",
      };
}
