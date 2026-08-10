import { describe, expect, it } from "vitest";
import { splitWorktreeReferences } from "./gitGraphReferences";

describe("splitWorktreeReferences", () => {
  it("groups generated worktree branches without hiding regular refs", () => {
    const refs = splitWorktreeReferences([
      { kind: "head", name: "HEAD" },
      { kind: "branch", name: "master" },
      { kind: "branch", name: "worktree-agent-a1043b5" },
      { kind: "branch", name: "worktree-agent-a4da3a7" },
      { kind: "remote", name: "origin/master" },
    ]);

    expect(refs.regular.map((ref) => ref.name)).toEqual([
      "HEAD",
      "master",
      "origin/master",
    ]);
    expect(refs.worktrees.map((ref) => ref.name)).toEqual([
      "worktree-agent-a1043b5",
      "worktree-agent-a4da3a7",
    ]);
  });

  it("does not group an ordinary branch that merely mentions worktree", () => {
    const refs = splitWorktreeReferences([
      { kind: "branch", name: "feature/worktree-cleanup" },
    ]);

    expect(refs.regular).toHaveLength(1);
    expect(refs.worktrees).toHaveLength(0);
  });
});
