import { describe, expect, it } from "vitest";
import { getGitSyncPlan } from "./gitSyncPolicy";

describe("getGitSyncPlan", () => {
  it("pushes an ahead-only branch", () => {
    expect(
      getGitSyncPlan({ ahead: 3, behind: 0 })
    ).toEqual({ action: "push" });
  });

  it("pulls a behind-only branch", () => {
    expect(
      getGitSyncPlan({ ahead: 0, behind: 2 })
    ).toEqual({ action: "pull" });
  });

  it("rebases then pushes a diverged branch", () => {
    expect(
      getGitSyncPlan({ ahead: 1, behind: 2 })
    ).toEqual({ action: "pull-rebase-and-push" });
  });

  it("does nothing when the branch is already synchronized", () => {
    expect(
      getGitSyncPlan({ ahead: 0, behind: 0 })
    ).toEqual({ action: "none" });
  });
});
