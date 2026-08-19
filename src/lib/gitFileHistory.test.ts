import { describe, expect, it } from "vitest";
import type { GitGraphCommit } from "@/types";
import { linearizeFileHistoryCommits } from "./gitFileHistory";

function commit(oid: string, parentOids: string[]): GitGraphCommit {
  return {
    oid,
    shortOid: oid.slice(0, 7),
    summary: oid,
    authorName: "Termflow",
    authorEmail: "termflow@example.com",
    timestampMs: 0,
    parentOids,
    refs: [],
  };
}

describe("linearizeFileHistoryCommits", () => {
  it("reconnects visible file commits across hidden unrelated commits", () => {
    const visible = [
      commit("newest", ["hidden-middle"]),
      commit("oldest", ["root-not-visible"]),
    ];

    const result = linearizeFileHistoryCommits(visible);

    expect(result[0].parentOids).toEqual(["oldest"]);
    expect(result[1].parentOids).toEqual([]);
    expect(visible[0].parentOids).toEqual(["hidden-middle"]);
  });
});
