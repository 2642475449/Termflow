import { expect, it } from "vitest";
import { filterMarketplaceCategory, marketplaceBrowseView, marketplaceInstallCommand, marketplaceCategory, marketplaceDetailErrorKind, marketplaceRepositoryUrl, marketplaceSkillKey, marketplaceSkillUrl, marketplaceIsGitHubSource } from "./skillMarketplace";

it("keeps skills from different repositories and folders distinct", () => {
  const skill = { repository: "owner/skills", slug: "review", name: "Review", description: "", installs: null };
  expect(marketplaceSkillKey(skill)).not.toBe(marketplaceSkillKey({ ...skill, slug: "other" }));
  expect(marketplaceSkillKey(skill)).not.toBe(marketplaceSkillKey({ ...skill, repository: "other/skills" }));
});

it("distinguishes unavailable skills from ambiguous directories and network failures", () => {
  expect(marketplaceDetailErrorKind("marketplace_skill_not_found")).toBe("unavailable");
  expect(marketplaceDetailErrorKind("marketplace_skill_ambiguous")).toBe("ambiguous");
  expect(marketplaceDetailErrorKind("Network request failed")).toBe("request");
});

it("links unavailable skills to their listing and source repository", () => {
  const skill = { repository: "mattpocock/skills", slug: "resolving-merge-conflicts", name: "resolving-merge-conflicts", description: "", installs: null };
  expect(marketplaceSkillUrl(skill)).toBe("https://skills.sh/mattpocock/skills/resolving-merge-conflicts");
  expect(marketplaceRepositoryUrl(skill)).toBe("https://github.com/mattpocock/skills");
});

it("groups discovery cards by their purpose and keeps all results available", () => {
  const skill = (slug: string) => ({ repository: "owner/skills", slug, name: slug, description: "", installs: null });
  const skills = [skill("react-best-practices"), skill("frontend-design"), skill("writing-docs"), skill("find-skills"), skill("postgres-sql")];
  expect(skills.map(marketplaceCategory)).toEqual(["development", "design", "content", "productivity", "data"]);
  expect(filterMarketplaceCategory(skills, "all")).toEqual(skills);
  expect(filterMarketplaceCategory(skills, "design")).toEqual([skills[1]]);
});

it("keeps featured groups fixed and paginates categories and the full leaderboard", () => {
  const skill = (slug: string) => ({ repository: "owner/skills", slug, name: slug, description: "", installs: null });
  const skills = [skill("agent-browser"), ...Array.from({ length: 30 }, (_, i) => skill(`find-skills-${i}`)),
    ...Array.from({ length: 30 }, (_, i) => skill(`react-${i}`))];
  const first = marketplaceBrowseView(skills, "all", 1);
  const development = skills.filter((entry) => marketplaceCategory(entry) === "development");
  const productivity = skills.filter((entry) => marketplaceCategory(entry) === "productivity");
  expect(first.overview).toBe(true);
  expect(first.sections.map((section) => section.category)).toEqual(["development", "productivity"]);
  expect(first.sections[0].skills).toEqual(development.slice(0, 6));
  expect(first.sections[1].skills).toEqual(productivity.slice(0, 6));
  expect(first.hasMore).toBe(false);
  const second = marketplaceBrowseView(skills, "all", 2);
  expect(second.sections).toEqual(first.sections);
  const view = marketplaceBrowseView(skills, "all", 8);
  expect(view.counts).toMatchObject({ all: 61, development: 31, productivity: 30 });
  expect(view.sections[0].skills).toEqual(development.slice(0, 6));
  expect(view.sections[1].skills).toEqual(productivity.slice(0, 6));
  expect(view.page).toBe(1);
  expect(view.hasMore).toBe(false);
  const category = marketplaceBrowseView(skills, "development", 2);
  expect(category).toMatchObject({ total: 31, page: 2, pageSize: 24, hasMore: false });
  expect(category.sections).toHaveLength(1);
  expect(category.sections[0].skills).toEqual(development.slice(24));
  const leaderboard = marketplaceBrowseView(skills, "all", 2, "leaderboard");
  expect(leaderboard.overview).toBe(false);
  expect(leaderboard.sections[0].skills).toEqual(skills.slice(24, 48));
  expect(leaderboard.hasMore).toBe(true);
  expect(marketplaceBrowseView(skills, "development", 8).page).toBe(2);
  expect(marketplaceBrowseView(skills, "data", 2)).toMatchObject({ total: 0, page: 1, sections: [] });
});

it("recognizes codebase and merge workflows as development tools", () => {
  for (const slug of ["improve-codebase-architecture", "resolving-merge-conflicts", "software-engineering", "tdd"]) {
    expect(marketplaceCategory({ repository: "owner/skills", slug, name: slug, description: "", installs: null })).toBe("development");
  }
});

it("separates unrecognized names from explicit productivity skills", () => {
  const make = (slug: string) => ({ repository: "owner/skills", slug, name: slug, description: "", installs: null });
  const cases = { "wizard": "other", "grill-me": "other", "planning-tasks": "productivity", "azure-rbac": "development", "lark-doc": "content", "lark-base": "data", "redesign-existing-projects": "design" };
  for (const [slug, category] of Object.entries(cases)) expect(marketplaceCategory(make(slug))).toBe(category);
  const view = marketplaceBrowseView(Object.keys(cases).map(make), "all", 1);
  expect(view.counts.other).toBe(2);
  expect(view.counts.productivity).toBe(1);
  expect(view.sections.reduce((count, section) => count + section.total, 0)).toBe(view.total);
});

it("links domain sources without treating them as GitHub installations", () => {
  const skill = { repository: "open.feishu.cn", slug: "lark-doc", name: "lark-doc", description: "", installs: null };
  expect(marketplaceSkillUrl(skill)).toBe("https://skills.sh/open.feishu.cn/lark-doc");
  expect(marketplaceIsGitHubSource(skill)).toBe(false);
  expect(marketplaceIsGitHubSource({ repository: "vercel-labs/agent-skills" })).toBe(true);
  for (const repository of ["owner/../repo", "https://example.com", "owner/.repo", "/repo", "owner/"]) expect(marketplaceIsGitHubSource({ repository })).toBe(false);
});

it("provides copyable commands for GitHub and domain sources without executing them", () => {
  expect(marketplaceInstallCommand({ repository: "vercel-labs/agent-skills", slug: "react" })).toBe("npx skills add vercel-labs/agent-skills --skill react");
  expect(marketplaceInstallCommand({ repository: "open.feishu.cn", slug: "lark-doc" })).toBe("npx skills add https://open.feishu.cn --skill lark-doc");
  for (const slug of ["--all", "review;whoami", "$(whoami)", "review`id`", "a & b", "../outside"]) expect(marketplaceInstallCommand({ repository: "owner/repo", slug })).toBeNull();
  for (const repository of ["https://evil.example", "owner/repo;id", "a/b/c", "-source", "x$(whoami)"]) expect(marketplaceInstallCommand({ repository, slug: "review" })).toBeNull();
});
