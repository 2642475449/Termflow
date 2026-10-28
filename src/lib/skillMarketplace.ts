import type { MarketplaceSkill, SkillAgent, SkillCatalog, SkillScope } from "@/types";
import { skillInstallTargets } from "./skills";

export const MARKETPLACE_CATEGORIES = ["all", "development", "design", "content", "productivity", "data"] as const;
export type MarketplaceCategory = typeof MARKETPLACE_CATEGORIES[number];

export function marketplaceCategory(skill: MarketplaceSkill): Exclude<MarketplaceCategory, "all"> {
  const text = `${skill.slug} ${skill.name}`.toLowerCase();
  if (/\b(data|sql|postgres|mysql|database|analytics|csv|xlsx|excel|pandas|spreadsheet|redis|supabase|snowflake|bigquery)\b/.test(text)) return "data";
  if (/\b(design|figma|ui|ux|css|tailwind|shadcn|accessibility|interface|typography|layout)\b/.test(text)) return "design";
  if (/\b(writ\w*|content|copywrit\w*|article|blog|pdf|docx|pptx|video|image|drawing|marketing|seo|slides|presentation|animation)\b/.test(text)) return "content";
  if (/\b(code|coding|react|next\w*|typescript|javascript|python|rust|test\w*|debug\w*|git|github|api|mcp|deploy\w*|docker|security|review|browser|web|frontend|backend|swift|flutter|native|vue|angular)\b/.test(text)) return "development";
  return "productivity";
}

export function filterMarketplaceCategory(skills: MarketplaceSkill[], category: MarketplaceCategory): MarketplaceSkill[] {
  return category === "all" ? skills : skills.filter((skill) => marketplaceCategory(skill) === category);
}

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
