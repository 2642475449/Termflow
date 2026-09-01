import { expect, test } from "vitest";
import {
  canAbortGitOperation,
  canContinueGitOperation,
  getGitConflictResolutionLabelKeys,
  getGitOperationLabelKey,
  isGitOperationInProgress,
} from "./gitOperationState";

test("normal Git actions are blocked only while an operation is in progress", () => {
  expect(isGitOperationInProgress("clean")).toBe(false);
  expect(isGitOperationInProgress("merge")).toBe(true);
  expect(isGitOperationInProgress("rebase-interactive")).toBe(true);
  expect(isGitOperationInProgress(undefined)).toBe(false);
});

test("conflict actions select the correct operation and rebase terminology", () => {
  expect(getGitOperationLabelKey("cherry-pick")).toBe("sidebar.gitOperationCherryPick");
  expect(canAbortGitOperation("rebase-merge")).toBe(true);
  expect(canAbortGitOperation("bisect")).toBe(false);
  expect(canContinueGitOperation("merge")).toBe(true);
  expect(canContinueGitOperation("apply-mailbox")).toBe(false);
  expect(getGitConflictResolutionLabelKeys("rebase")).toEqual({
    ours: "sidebar.gitResolveOursRebase",
    theirs: "sidebar.gitResolveTheirsRebase",
  });
  expect(getGitConflictResolutionLabelKeys("merge")).toEqual({
    ours: "sidebar.gitResolveOurs",
    theirs: "sidebar.gitResolveTheirs",
  });
});
