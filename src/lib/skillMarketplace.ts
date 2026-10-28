import type { MarketplaceSkill, SkillAgent, SkillCatalog, SkillScope } from "@/types";
import { skillInstallTargets } from "./skills";

export function marketplaceSkillKey(skill: MarketplaceSkill): string {
  return `${skill.repository}:${skill.slug}`;
}

export function marketplaceDetailErrorKind(reason: string | null): "unavailable" | "ambiguous" | "request" {
  if (reason === "marketplace_skill_not_found") return "unavailable";
  if (reason === "marketplace_skill_ambiguous") return "ambiguous";
  return "request";
}

export function marketplaceSkillUrl(skill: MarketplaceSkill): string {
  return `https://skills.sh/${skill.repository.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(skill.slug)}`;
}

export function marketplaceRepositoryUrl(skill: MarketplaceSkill): string {
  return `https://github.com/${skill.repository.split("/").map(encodeURIComponent).join("/")}`;
}

export function marketplaceConflicts(catalog: SkillCatalog | null, folder: string, agents: SkillAgent[], scope: SkillScope): string[] {
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const targets = skillInstallTargets(catalog, agents, scope).map(({ path }) => normalize(`${path}/${folder}/SKILL.md`));
  return (catalog?.skills ?? []).filter((skill) => targets.includes(normalize(skill.filePath))).map((skill) => skill.filePath);
}
