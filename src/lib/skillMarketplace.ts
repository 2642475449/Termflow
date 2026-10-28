import type { MarketplaceSkill, SkillAgent, SkillCatalog, SkillScope } from "@/types";
import { skillInstallTargets } from "./skills";

export const MARKETPLACE_CATEGORIES = ["all", "development", "design", "content", "productivity", "data"] as const;
export type MarketplaceCategory = typeof MARKETPLACE_CATEGORIES[number];

export function marketplaceCategory(skill: MarketplaceSkill): Exclude<MarketplaceCategory, "all"> {
  const text = `${skill.slug} ${skill.name}`.toLowerCase();
  if (/\b(data|sql|postgres|mysql|database|analytics|csv|xlsx|excel|pandas|spreadsheet|redis|supabase|snowflake|bigquery)\b/.test(text)) return "data";
  if (/\b(design|figma|ui|ux|css|tailwind|shadcn|accessibility|interface|typography|layout)\b/.test(text)) return "design";
  if (/\b(writ\w*|content|copywrit\w*|article|blog|pdf|docx|pptx|video|image|drawing|marketing|seo|slides|presentation|animation)\b/.test(text)) return "content";
  if (/\b(code|codebase|coding|programming|software|react|next\w*|typescript|javascript|python|rust|test\w*|tdd|debug\w*|bug\w*|git|github|merge|conflicts|api|mcp|deploy\w*|docker|security|review|browser|web|frontend|backend|swift|flutter|native|vue|angular)\b/.test(text)) return "development";
  return "productivity";
}

export function filterMarketplaceCategory(skills: MarketplaceSkill[], category: MarketplaceCategory): MarketplaceSkill[] {
  return category === "all" ? skills : skills.filter((skill) => marketplaceCategory(skill) === category);
}

// 全部展示分类概览；进入单个分类后，才对该分类的完整列表分页。
export function marketplaceBrowseView(skills: MarketplaceSkill[], category: MarketplaceCategory, requestedPage: number) {
  const counts = { all: skills.length, development: 0, design: 0, content: 0, productivity: 0, data: 0 };
  const sections = MARKETPLACE_CATEGORIES.filter((value) => value !== "all").map((value) => {
    const entries = filterMarketplaceCategory(skills, value);
    counts[value] = entries.length;
    return { category: value, total: entries.length, skills: entries };
  });
  const total = counts[category];
  const pageSize = 24;
  const page = Math.max(1, Math.min(Math.floor(requestedPage) || 1, Math.ceil(total / pageSize)));
  const overview = category === "all";
  return {
    counts, total, page, pageSize, overview,
    sections: sections.filter((section) => section.total && (overview || section.category === category))
      .map((section) => ({ ...section, skills: overview ? section.skills.slice(0, 6) : section.skills.slice((page - 1) * pageSize, page * pageSize) })),
  };
}

export function marketplaceSkillKey(skill: Pick<MarketplaceSkill, "repository" | "slug">): string {
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
