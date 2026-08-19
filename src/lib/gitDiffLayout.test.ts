import { describe, expect, it } from "vitest";
import { shouldRenderGitDiffSideBySide } from "./gitDiffLayout";

describe("shouldRenderGitDiffSideBySide", () => {
  it.each(["added", "untracked"])(
    "uses a full-width inline diff for %s files",
    (changeKind) => {
      expect(shouldRenderGitDiffSideBySide(changeKind)).toBe(false);
    },
  );

  it.each([undefined, "modified", "deleted", "renamed"])(
    "keeps the comparison panes for %s files",
    (changeKind) => {
      expect(shouldRenderGitDiffSideBySide(changeKind)).toBe(true);
    },
  );
});
