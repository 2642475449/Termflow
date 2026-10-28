import { expect, it } from "vitest";
import type { SkillCatalog } from "@/types";
import { marketplaceConflicts, marketplaceDetailErrorKind, marketplaceRepositoryUrl, marketplaceSkillKey, marketplaceSkillUrl } from "./skillMarketplace";

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
