import { describe, expect, it } from "vitest";
import {
  DEFAULT_GIT_COMMIT_MESSAGE_PROFILE_ID,
  normalizeDefaultGitCommitMessageProfileId,
  normalizeGitCommitMessageProfiles,
} from "./gitCommitMessageProfiles";

describe("git commit message profiles", () => {
  it("restores built-in profiles when persisted data is unavailable", () => {
    const profiles = normalizeGitCommitMessageProfiles(undefined);
    expect(profiles).toHaveLength(4);
    expect(profiles[0].id).toBe(DEFAULT_GIT_COMMIT_MESSAGE_PROFILE_ID);
  });

  it("drops malformed and duplicate profiles", () => {
    expect(normalizeGitCommitMessageProfiles([
      { id: "custom", name: " Custom ", instructions: " Rules " },
      { id: "custom", name: "Duplicate", instructions: "Ignored" },
      { id: "empty", name: "", instructions: "Ignored" },
    ])).toEqual([{ id: "custom", name: "Custom", instructions: "Rules" }]);
  });

  it("falls back to the first available profile when the default is missing", () => {
    const profiles = [{ id: "custom", name: "Custom", instructions: "Rules" }];
    expect(normalizeDefaultGitCommitMessageProfileId("missing", profiles)).toBe("custom");
  });
});
