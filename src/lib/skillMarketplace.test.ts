import { expect, it } from "vitest";
import type { SkillCatalog } from "@/types";
import { filterMarketplaceCategory, marketplaceBrowseView, marketplaceCategory, marketplaceConflicts, marketplaceDetailErrorKind, marketplaceRepositoryUrl, marketplaceSkillKey, marketplaceSkillUrl } from "./skillMarketplace";

it("keeps skills from different repositories and folders distinct", () => {
  const skill = { repository: "owner/skills", slug: "review", name: "Review", description: "", installs: null };
  expect(marketplaceSkillKey(skill)).not.toBe(marketplaceSkillKey({ ...skill, slug: "other" }));
  expect(marketplaceSkillKey(skill)).not.toBe(marketplaceSkillKey({ ...skill, repository: "other/skills" }));
});

it("checks physical target paths rather than assuming a matching name is installed", () => {
  const catalog: SkillCatalog = { roots: [
    { agent: "codex", scope: "workspace", enabledDir: "C:\\project\\.agents\\skills" },
    { agent: "pi", scope: "workspace", enabledDir: "C:\\project\\.agents\\skills" },
  ], skills: [] };
  const existing: SkillCatalog["skills"][number] = {
    id: "review", name: "Review", description: "", enabled: true, scope: "workspace", agent: "codex",
    effectiveAgents: ["codex", "pi"], conflictStatus: "none", conflictAgents: [], conflictingPaths: [],
    contentFingerprint: "hash", folderName: "review", filePath: "c:/PROJECT/.agents/skills/review/SKILL.md",
    resolvedFilePath: "c:/PROJECT/.agents/skills/review/SKILL.md", entryIsLink: false, sourceDir: "c:/project/.agents/skills",
  };
  catalog.skills.push(existing);
  expect(marketplaceConflicts(catalog, "review", ["codex", "pi"], "workspace")).toEqual([existing.filePath]);
  expect(marketplaceConflicts(catalog, "review", ["claude"], "workspace")).toEqual([]);
  expect(marketplaceConflicts(catalog, "review", ["codex"], "user")).toEqual([]);
  expect(marketplaceConflicts(null, "review", ["codex"], "user")).toEqual([]);
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

it("builds category previews from the entire catalog rather than the first mixed page", () => {
  const skill = (slug: string) => ({ repository: "owner/skills", slug, name: slug, description: "", installs: null });
  const skills = [skill("agent-browser"), ...Array.from({ length: 30 }, (_, i) => skill(`find-skills-${i}`)),
    ...Array.from({ length: 30 }, (_, i) => skill(`react-${i}`))];
  const view = marketplaceBrowseView(skills, "all", 8);
  expect(view.overview).toBe(true);
  expect(view.counts).toMatchObject({ all: 61, development: 31, productivity: 30 });
  expect(view.sections.find((section) => section.category === "development")).toMatchObject({ total: 31, skills: skills.filter((entry) => marketplaceCategory(entry) === "development").slice(0, 6) });
  expect(view.sections.every((section) => section.skills.length === 6)).toBe(true);
  const category = marketplaceBrowseView(skills, "development", 2);
  expect(category).toMatchObject({ overview: false, total: 31, page: 2, pageSize: 24 });
  expect(category.sections).toHaveLength(1);
  expect(category.sections[0].skills).toEqual(skills.filter((entry) => marketplaceCategory(entry) === "development").slice(24));
  expect(marketplaceBrowseView(skills, "development", 8).page).toBe(2);
  expect(marketplaceBrowseView(skills, "data", 2)).toMatchObject({ total: 0, page: 1, sections: [] });
});

it("recognizes codebase and merge workflows as development tools", () => {
  for (const slug of ["improve-codebase-architecture", "resolving-merge-conflicts", "software-engineering", "tdd"]) {
    expect(marketplaceCategory({ repository: "owner/skills", slug, name: slug, description: "", installs: null })).toBe("development");
  }
});
