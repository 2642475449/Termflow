import { describe, expect, it } from "vitest";
import type { GitGraphChangedFile } from "@/types";
import { getGitGraphExpansionRowCount } from "./GitGraphChangedFiles";

const changedFiles: GitGraphChangedFile[] = [
  { path: "src/main.ts", oldPath: null, status: "modified" },
  { path: "src/new.ts", oldPath: null, status: "added" },
];

describe("getGitGraphExpansionRowCount", () => {
  it("reserves one row for loading, error, and empty states", () => {
    expect(getGitGraphExpansionRowCount([], true, false)).toBe(1);
    expect(getGitGraphExpansionRowCount([], false, true)).toBe(1);
    expect(getGitGraphExpansionRowCount([], false, false)).toBe(1);
  });

  it("uses one virtual row per changed file", () => {
    expect(getGitGraphExpansionRowCount(changedFiles, false, false)).toBe(2);
  });
});
