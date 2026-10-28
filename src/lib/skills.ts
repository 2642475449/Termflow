import type { SkillAgent, SkillCatalog, SkillInfo, SkillScope } from "@/types";

export interface SkillGroup {
  id: string;
  skill: SkillInfo;
  locations: SkillInfo[];
}

// 只合并同一实际文件。内容一致的独立副本仍保留，避免隐藏后续分叉。
export function groupSkills(skills: SkillInfo[]): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  for (const skill of skills) {
    const id = skill.resolvedFilePath || skill.filePath;
    const existing = groups.get(id);
    if (existing) existing.locations.push(skill);
    else groups.set(id, { id, skill, locations: [skill] });
  }
  return [...groups.values()];
}

export function isSkillLinked(skill: SkillInfo): boolean {
  // Windows canonicalize 返回的设备前缀已由后端 display_path 清理。
  const normalize = (path: string) => path.replace(/\\/g, "/");
  return normalize(skill.resolvedFilePath) !== normalize(skill.filePath);
}

export function skillConsumers(agent: SkillAgent, scope: SkillScope): SkillAgent[] {
  if (agent === "claude") return ["claude", "opencode"];
  if (agent === "codex" || agent === "pi" || (agent === "antigravity" && scope === "workspace")) {
    return scope === "workspace" ? ["codex", "antigravity", "opencode", "pi"] : ["codex", "opencode", "pi"];
  }
  return [agent];
}

export function skillInstallTargets(catalog: SkillCatalog | null, agents: SkillAgent[], scope: SkillScope) {
  const paths = new Map<string, { path: string; consumers: SkillAgent[] }>();
  for (const agent of agents) {
    const path = catalog?.roots.find((root) => root.agent === agent && root.scope === scope)?.enabledDir;
    if (path && !paths.has(path)) paths.set(path, { path, consumers: skillConsumers(agent, scope) });
  }
  return [...paths.values()];
}

export function skillFolderName(name: string, source: string | null): string {
  if (source) return source.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? "";
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64).replace(/-$/, "") || "new-skill";
}

export function skillEditorKey(projectPath: string | null, resolvedPath: string): string {
  return JSON.stringify([projectPath, resolvedPath]);
}

export function skillMarkdownBody(content: string): string {
  return content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

export function skillToggleBlocked(skill: SkillInfo, catalog: SkillCatalog): boolean {
  // 移动被其他入口引用的真实目录会留下失效链接；链接入口本身可独立移动。
  return !skill.entryIsLink && catalog.skills.some((other) => other.id !== skill.id
    && other.resolvedFilePath === skill.resolvedFilePath);
}

export function filterSkillGroups(groups: SkillGroup[], search: string, agent: "all" | SkillAgent,
  scope: "all" | SkillScope, status: "all" | "enabled" | "disabled") {
  const keyword = search.trim().toLowerCase();
  return groups.map((group) => ({ ...group, locations: group.locations.filter((skill) =>
    (agent === "all" || skill.effectiveAgents.includes(agent))
    && (scope === "all" || skill.scope === scope)
    && (status === "all" || skill.enabled === (status === "enabled"))) }))
    .filter((group) => group.locations.length && (!keyword || group.locations.some((skill) =>
      [skill.name, skill.description, skill.filePath, skill.resolvedFilePath].join(" ").toLowerCase().includes(keyword))));
}
