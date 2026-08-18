import type { GitCommitMessageProfile } from "@/types";

export const DEFAULT_GIT_COMMIT_MESSAGE_PROFILE_ID = "conventional-zh-full";

export const DEFAULT_GIT_COMMIT_MESSAGE_PROFILES: readonly GitCommitMessageProfile[] = [
  {
    id: DEFAULT_GIT_COMMIT_MESSAGE_PROFILE_ID,
    name: "默认",
    instructions:
      "使用中文生成 Conventional Commit。第一行为 type(scope): summary 风格标题，标题后空一行，再输出 2-4 条以 `- ` 开头的正文要点。",
  },
  {
    id: "concise-en-title",
    name: "精简",
    instructions:
      "只输出一行简洁的英文 Conventional Commit 标题，不要正文，标题尽量控制在 72 个字符以内。",
  },
  {
    id: "team-standard",
    name: "团队规范",
    instructions:
      "使用 type(scope): subject 格式；标题使用中文，正文固定为“变更内容”和“影响范围”两个要点，不要添加无法从变更概览确认的信息。",
  },
  {
    id: "emoji",
    name: "Emoji",
    instructions:
      "在 Conventional Commit 标题前添加一个最符合改动类型的 Emoji，例如 ✨ feat:、🐛 fix: 或 📝 docs:；正文使用中文并保持简洁。",
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

  return profiles.length > 0 ? profiles : createDefaultGitCommitMessageProfiles();
}

export function normalizeDefaultGitCommitMessageProfileId(
  value: unknown,
  profiles: readonly GitCommitMessageProfile[],
): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  return profiles.some((profile) => profile.id === candidate)
    ? candidate
    : profiles[0]?.id ?? DEFAULT_GIT_COMMIT_MESSAGE_PROFILE_ID;
}
