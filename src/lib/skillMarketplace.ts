import type { MarketplaceSkill, SkillAgent, SkillCatalog, SkillScope } from "@/types";
import { skillInstallTargets } from "./skills";

export function marketplaceSkillKey(skill: MarketplaceSkill): string {
  return `${skill.provider}:${skill.repository}:${skill.slug}`;
}

export function marketplaceConflicts(catalog: SkillCatalog | null, folder: string, agents: SkillAgent[], scope: SkillScope): string[] {
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const targets = skillInstallTargets(catalog, agents, scope).map(({ path }) => normalize(`${path}/${folder}/SKILL.md`));
  return (catalog?.skills ?? []).filter((skill) => targets.includes(normalize(skill.filePath))).map((skill) => skill.filePath);
}
