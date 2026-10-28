import { describe, expect, it } from "vitest";
import {
  createDefaultGitCommitMessageProfiles,
  createDuplicateGitCommitMessageProfileName,
  DEFAULT_GIT_COMMIT_MESSAGE_PROFILE_ID,
  hasBuiltInGitCommitMessageProfileChanges,
  isBuiltInGitCommitMessageProfile,
  isBuiltInGitCommitMessageProfileModified,
  normalizeDefaultGitCommitMessageProfileId,
  normalizeGitCommitMessageProfiles,
  resetBuiltInGitCommitMessageProfiles,
  resetSingleBuiltInGitCommitMessageProfile,
} from "./gitCommitMessageProfiles";

describe("git commit message profiles", () => {
  it("restores built-in profiles when persisted data is unavailable", () => {
    const profiles = normalizeGitCommitMessageProfiles(undefined);
    expect(profiles).toHaveLength(3);
    expect(profiles).toContainEqual(expect.objectContaining({ id: DEFAULT_GIT_COMMIT_MESSAGE_PROFILE_ID }));
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

  it("replaces retired built-ins and retains user-created styles", () => {
    const profiles = normalizeGitCommitMessageProfiles([
      { id: "conventional-zh-full", name: "默认", instructions: "旧规则" },
      { id: "emoji", name: "Emoji", instructions: "旧规则" },
      { id: "release-notes", name: "发布说明", instructions: "自定义规则" },
    ]);

    expect(profiles.map((profile) => profile.id)).toEqual([
      "concise",
      "balanced",
      "detailed",
      "release-notes",
    ]);
    expect(normalizeDefaultGitCommitMessageProfileId("conventional-zh-full", profiles)).toBe(
      DEFAULT_GIT_COMMIT_MESSAGE_PROFILE_ID,
    );
  });

  it("refreshes an outdated built-in without overwriting a user-edited built-in", () => {
    const profiles = normalizeGitCommitMessageProfiles([
      {
        id: "concise",
        name: "精简",
        instructions: "使用中文生成 Conventional Commit。只输出一行 `type(scope): 摘要` 标题，准确点明最主要的改动，不要正文；标题尽量控制在 72 个字符以内。",
      },
      { id: "balanced", name: "我的适中", instructions: "用户调整过的规则" },
    ]);

    expect(profiles.find((profile) => profile.id === "balanced")).toEqual({
      id: "balanced",
      name: "我的适中",
      instructions: "用户调整过的规则",
    });
    expect(profiles.find((profile) => profile.id === "detailed")).toBeDefined();
  });

  it("detects modified or missing built-in profiles and restores them while keeping custom profiles", () => {
    const defaults = createDefaultGitCommitMessageProfiles();
    expect(hasBuiltInGitCommitMessageProfileChanges(defaults)).toBe(false);
    expect(isBuiltInGitCommitMessageProfile("balanced")).toBe(true);
    expect(isBuiltInGitCommitMessageProfile("custom-1")).toBe(false);

    const modified = [
      { id: "balanced", name: "适中（改）", instructions: "自定义适中规则" },
      { id: "custom-1", name: "团队规范", instructions: "团队自定义规则" },
    ];
    expect(isBuiltInGitCommitMessageProfileModified(modified[0])).toBe(true);
    expect(hasBuiltInGitCommitMessageProfileChanges(modified)).toBe(true);

    const singleReset = resetSingleBuiltInGitCommitMessageProfile(modified, "balanced");
    expect(isBuiltInGitCommitMessageProfileModified(singleReset[0])).toBe(false);

    const allReset = resetBuiltInGitCommitMessageProfiles(modified);
    expect(allReset.map((item) => item.id)).toEqual([
      "concise",
      "balanced",
      "detailed",
      "custom-1",
    ]);
    expect(hasBuiltInGitCommitMessageProfileChanges(allReset)).toBe(false);
  });

  it("creates unique duplicate profile names without colliding with existing profiles", () => {
    const existing = [
      { id: "balanced", name: "适中", instructions: "规则" },
      { id: "copy-1", name: "适中 副本", instructions: "规则" },
    ];
    expect(createDuplicateGitCommitMessageProfileName("适中", existing, "副本")).toBe(
      "适中 副本 2",
    );
  });
});
