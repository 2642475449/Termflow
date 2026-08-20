import type { GitCommitMessageProfile } from "@/types";

export const DEFAULT_GIT_COMMIT_MESSAGE_PROFILE_ID = "balanced";

const LEGACY_BUILT_IN_PROFILE_IDS = new Set([
  "conventional-zh-full",
  "concise-en-title",
  "team-standard",
  "emoji",
]);

const OUTDATED_THREE_TIER_INSTRUCTIONS: Record<string, string> = {
  concise:
    "使用中文生成 Conventional Commit。只输出一行 `type(scope): 摘要` 标题，准确点明最主要的改动，不要正文；标题尽量控制在 72 个字符以内。",
  balanced:
    "使用中文生成 Conventional Commit。第一行为 `type(scope): 摘要` 标题，空一行后输出 3-5 条以 `- ` 开头的正文。每条必须说明一个实际改动：点明文件、组件或模块，以及具体行为变化；禁止只写“优化”“调整”“重构”等没有对象和结果的笼统表述。",
  detailed:
    "使用中文生成 Conventional Commit。第一行为 `type(scope): 摘要` 标题，空一行后以“变更明细：”开始，输出 4-8 条以 `- ` 开头的要点；每条必须列出具体文件、组件或模块和对应的实现/行为变化。若 diff 能确认用户可见影响，再追加“行为影响：”并列出 1-3 条；无法确认时不要猜测。不要使用“变更内容”“影响范围”这种空泛标题，也不要只罗列文件名或统计数字。",
};

export const DEFAULT_GIT_COMMIT_MESSAGE_PROFILES: readonly GitCommitMessageProfile[] = [
  {
    id: "concise",
    name: "精简",
    instructions:
      "使用中文生成 Conventional Commit。只输出一行 `type(scope): 摘要` 标题，准确点明最主要的改动，不要正文；标题尽量控制在 72 个字符以内。若包含多项独立改动，选择共同主题概括，不要把文件名或要点串成清单。",
  },
  {
    id: DEFAULT_GIT_COMMIT_MESSAGE_PROFILE_ID,
    name: "适中",
    instructions:
      "使用中文生成 Conventional Commit。第一行为 `type(scope): 摘要` 标题，空一行后按独立改动主题输出 2-5 条以 `- ` 开头的正文；小改动可少于 2 条，不要为了凑数量拆分同一件事。每条必须点明文件、组件或模块及实际实现变化；只有 diff 能证实时才说明用户行为或影响。禁止只写“优化”“调整”“重构”等没有对象和事实的笼统表述。",
  },
  {
    id: "detailed",
    name: "详细",
    instructions:
      "使用中文生成 Conventional Commit。第一行为 `type(scope): 摘要` 标题，空一行后以“变更明细：”开始，按独立改动主题输出 3-8 条以 `- ` 开头的要点；覆盖主要变更但不要机械罗列每个文件。每条必须包含具体文件、组件或模块及实际实现变化；只有 diff 明确表明时才描述用户行为或兼容性影响。若 diff 中包含测试文件的新增或修改，可追加“测试：”并说明测试代码改了什么；不得声称测试已通过。不要使用空泛的“变更内容”“影响范围”标题，也不要只罗列文件名或统计数字。",
  },
];

export function createDefaultGitCommitMessageProfiles(): GitCommitMessageProfile[] {
  return DEFAULT_GIT_COMMIT_MESSAGE_PROFILES.map((profile) => ({ ...profile }));
}

export function normalizeGitCommitMessageProfiles(
  value: unknown,
): GitCommitMessageProfile[] {
  if (!Array.isArray(value)) {
    return createDefaultGitCommitMessageProfiles();
  }

  const profiles: GitCommitMessageProfile[] = [];
  const ids = new Set<string>();

  for (const candidate of value.slice(0, 50)) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim().slice(0, 120) : "";
    const name = typeof record.name === "string" ? record.name.trim().slice(0, 80) : "";
    const instructions =
      typeof record.instructions === "string"
        ? record.instructions.trim().slice(0, 6000)
        : "";
    if (!id || !name || !instructions || ids.has(id)) continue;

    ids.add(id);
    profiles.push({ id, name, instructions });
  }

  if (profiles.length === 0) return createDefaultGitCommitMessageProfiles();

  // Replace retired built-ins while retaining profiles created by the user.
  // This upgrades existing installations to the three supported detail levels.
  const hasRetiredBuiltIn = profiles.some((profile) => LEGACY_BUILT_IN_PROFILE_IDS.has(profile.id));
  const hasOutdatedThreeTierProfile = profiles.some(
    (profile) => OUTDATED_THREE_TIER_INSTRUCTIONS[profile.id] === profile.instructions
  );
  if (!hasRetiredBuiltIn && !hasOutdatedThreeTierProfile) return profiles;

  const builtInIds = new Set(DEFAULT_GIT_COMMIT_MESSAGE_PROFILES.map((profile) => profile.id));
  const builtInOverrides = profiles.filter(
    (profile) =>
      builtInIds.has(profile.id)
      && OUTDATED_THREE_TIER_INSTRUCTIONS[profile.id] !== profile.instructions
  );
  const customProfiles = profiles.filter(
    (profile) =>
      !LEGACY_BUILT_IN_PROFILE_IDS.has(profile.id)
      && OUTDATED_THREE_TIER_INSTRUCTIONS[profile.id] !== profile.instructions
      && !builtInIds.has(profile.id)
  );
  const overriddenIds = new Set(builtInOverrides.map((profile) => profile.id));
  const refreshedBuiltIns = createDefaultGitCommitMessageProfiles().filter(
    (profile) => !overriddenIds.has(profile.id)
  );
  return [...refreshedBuiltIns, ...builtInOverrides, ...customProfiles];
}

export function normalizeDefaultGitCommitMessageProfileId(
  value: unknown,
  profiles: readonly GitCommitMessageProfile[],
): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  return profiles.some((profile) => profile.id === candidate)
    ? candidate
    : profiles.find((profile) => profile.id === DEFAULT_GIT_COMMIT_MESSAGE_PROFILE_ID)?.id
      ?? profiles[0]?.id
      ?? DEFAULT_GIT_COMMIT_MESSAGE_PROFILE_ID;
}
