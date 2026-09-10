import { describe, expect, it } from "vitest";
import { getGitRemoteAction, type GitRemoteState } from "./gitRemoteAction";
import type { GitBranchInfo } from "@/types";

const branch: GitBranchInfo = {
  branchName: "main",
  ahead: 0,
  behind: 0,
  isDetached: false,
  operationState: "clean",
};
const state: GitRemoteState = {
  branchName: "main",
  remotes: [{ name: "origin", url: "repo" }],
  upstream: "origin/main",
  hasCommit: true,
  branches: ["origin/main"],
};
describe("Git remote primary action", () => {
  it("does not confuse unavailable configuration with no remotes", () => {
    expect(getGitRemoteAction(null, branch)).toBe("retry");
    expect(getGitRemoteAction({ ...state, remotes: [] }, branch)).toBe("add");
  });
  it("publishes only committed local branches without upstream", () => {
    expect(getGitRemoteAction({ ...state, upstream: null }, branch)).toBe(
      "publish",
    );
    expect(
      getGitRemoteAction(
        { ...state, upstream: null, hasCommit: false },
        branch,
      ),
    ).toBe("fetch");
    expect(getGitRemoteAction(state, { ...branch, isDetached: true })).toBe(
      "fetch",
    );
  });
  it.each([
    [0, 0, "fetch"],
    [3, 0, "push"],
    [0, 2, "pull"],
    [3, 2, "sync"],
  ] as const)("maps %i ahead and %i behind to %s", (ahead, behind, action) => {
    expect(getGitRemoteAction(state, { ...branch, ahead, behind })).toBe(
      action,
    );
  });
});
