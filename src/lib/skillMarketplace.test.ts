import { expect, it } from "vitest";
import type { SkillCatalog } from "@/types";
import { marketplaceConflicts, marketplaceSkillKey } from "./skillMarketplace";

it("keeps skills from different providers and repositories distinct", () => {
  const skill = { provider: "openai" as const, repository: "openai/skills", slug: "review", name: "Review", description: "", installs: null };
  expect(marketplaceSkillKey(skill)).not.toBe(marketplaceSkillKey({ ...skill, provider: "community" }));
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
