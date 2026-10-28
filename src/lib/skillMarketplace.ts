import type { MarketplaceSkill } from "@/types";

export const MARKETPLACE_CATEGORIES = ["all", "development", "design", "content", "productivity", "data", "other"] as const;
export type MarketplaceCategory = typeof MARKETPLACE_CATEGORIES[number];

export function marketplaceCategory(skill: MarketplaceSkill): Exclude<MarketplaceCategory, "all"> {
  const text = `${skill.slug} ${skill.name}`.toLowerCase();
  if (/\b(data|sql|postgres|mysql|database|analytics|csv|xlsx|excel|pandas|spreadsheet|redis|supabase|snowflake|bigquery|storage|statistics|visualization)\b|lark-base/.test(text)) return "data";
  if (/\b(design|redesign\w*|figma|ui|ux|css|tailwind|shadcn|accessibility|interface|typography|layout|prototype)\b/.test(text)) return "design";
  if (/\b(writ\w*|content|copywrit\w*|article|blog|docs?|document\w*|pdf|docx|pptx|video|image|drawing|marketing|seo|slides|presentation|animation|audio|media|captions|brand\w*|motion|remotion)\b/.test(text)) return "content";
  if (/\b(code|codebase|coding|programming|software|engineering|react|next\w*|typescript|javascript|python|rust|test\w*|tdd|debug\w*|diagnos\w*|bug\w*|git|github|merge|conflicts|commit|api|mcp|cli|deploy\w*|docker|security|review|browser|web|frontend|backend|swift|flutter|native|vue|angular|azure|cloud|prisma)\b|microsoft-foundry/.test(text)) return "development";
  if (/\b(productivity|workflow|planning|plan|brainstorm\w*|research|search|task\w*|schedul\w*|meeting\w*|notes?|calendar|email|inbox|organize|automation|okr|approval|attendance|drive|wiki|chat|messenger)\b|find-skills/.test(text)) return "productivity";
  return "other";
}

export function marketplaceIsGitHubSource(skill: Pick<MarketplaceSkill, "repository">): boolean {
  const parts = skill.repository.split("/");
  return parts.length === 2 && parts.every((part) => part.length <= 100 && !part.startsWith(".") && /^[a-z0-9_.-]+$/i.test(part));
}

// 命令仅供展示和复制；只接受可直接作为 shell 参数的目录标识，避免拼入命令字符。
export function marketplaceInstallCommand(skill: Pick<MarketplaceSkill, "repository" | "slug">): string | null {
  const parts = skill.repository.split("/");
  if (parts.length > 2 || !parts.every((part) => /^[a-z0-9][a-z0-9_.-]{0,99}$/i.test(part))
    || !/^[a-z0-9][a-z0-9_.-]{0,199}$/i.test(skill.slug)) return null;
  const source = marketplaceIsGitHubSource(skill) ? skill.repository : `https://${skill.repository}`;
  return `npx skills add ${source} --skill ${skill.slug}`;
}

export function filterMarketplaceCategory(skills: MarketplaceSkill[], category: MarketplaceCategory): MarketplaceSkill[] {
  return category === "all" ? skills : skills.filter((skill) => marketplaceCategory(skill) === category);
}

// 全部展示分类概览；进入单个分类后，才对该分类的完整列表分页。
export function marketplaceBrowseView(skills: MarketplaceSkill[], category: MarketplaceCategory, requestedPage: number) {
  const counts = { all: skills.length, development: 0, design: 0, content: 0, productivity: 0, data: 0, other: 0 };
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

export function marketplaceDetailErrorKind(reason: string | null): "unavailable" | "ambiguous" | "previewUnavailable" | "request" {
  if (reason === "marketplace_skill_not_found") return "unavailable";
  if (reason === "marketplace_skill_ambiguous") return "ambiguous";
  if (reason === "marketplace_preview_unavailable") return "previewUnavailable";
  return "request";
}

export function marketplaceSkillUrl(skill: MarketplaceSkill): string {
  return `https://skills.sh/${skill.repository.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(skill.slug)}`;
}

export function marketplaceRepositoryUrl(skill: MarketplaceSkill): string {
  return `https://github.com/${skill.repository.split("/").map(encodeURIComponent).join("/")}`;
}
