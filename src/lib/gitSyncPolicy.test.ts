import { describe, expect, it } from "vitest";
import { getGitSyncPlan } from "./gitSyncPolicy";

describe("getGitSyncPlan", () => {
  it("pushes an ahead-only branch even with local changes", () => {
    expect(
      getGitSyncPlan({ ahead: 3, behind: 0, hasLocalChanges: true })
    ).toEqual({ action: "push", blockedByLocalChanges: false });
  });

  it("pulls a behind-only branch when the worktree is clean", () => {
    expect(
      getGitSyncPlan({ ahead: 0, behind: 2, hasLocalChanges: false })
    ).toEqual({ action: "pull", blockedByLocalChanges: false });
  });

  it("blocks a pull when local changes exist", () => {
    expect(
      getGitSyncPlan({ ahead: 0, behind: 2, hasLocalChanges: true })
    ).toEqual({ action: "none", blockedByLocalChanges: true });
  });

  it("rebases then pushes a diverged clean branch", () => {
    expect(
      getGitSyncPlan({ ahead: 1, behind: 2, hasLocalChanges: false })
    ).toEqual({
      action: "pull-rebase-and-push",
      blockedByLocalChanges: false,
    });
  });

  it("blocks a diverged branch when local changes exist", () => {
    expect(
      getGitSyncPlan({ ahead: 1, behind: 2, hasLocalChanges: true })
    ).toEqual({ action: "none", blockedByLocalChanges: true });
  });

  it("does nothing when the branch is already synchronized", () => {
    expect(
      getGitSyncPlan({ ahead: 0, behind: 0, hasLocalChanges: true })
    ).toEqual({ action: "none", blockedByLocalChanges: false });
  });
});
