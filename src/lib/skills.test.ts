import { describe, expect, it } from "vitest";
import type { SkillCatalog, SkillInfo } from "@/types";
import { filterSkillGroups, groupSkills, isSkillLinked, skillEditorKey, skillMarkdownBody, skillFolderName, skillInstallTargets, skillToggleBlocked } from "./skills";

const skill = (overrides: Partial<SkillInfo> = {}): SkillInfo => ({
  id: "codex:workspace:review", name: "review", description: "Review changes", enabled: true,
  scope: "workspace", agent: "codex", effectiveAgents: ["codex", "opencode"],
  conflictStatus: "none", conflictAgents: [], conflictingPaths: [], contentFingerprint: "same",
  folderName: "review", filePath: "/project/.agents/skills/review/SKILL.md",
  resolvedFilePath: "/project/.agents/skills/review/SKILL.md", entryIsLink: false, sourceDir: "/project/.agents/skills", ...overrides,
});

describe("skill library", () => {
  it("groups linked files but retains independent identical copies", () => {
    const original = skill();
    const link = skill({ id: "claude", agent: "claude", filePath: "/project/.claude/skills/review/SKILL.md" });
    const copy = skill({ id: "copy", resolvedFilePath: "/copy/SKILL.md", filePath: "/copy/SKILL.md" });
    const groups = groupSkills([original, link, copy]);
    expect(groups).toHaveLength(2);
    expect(groups[0].locations).toEqual([original, link]);
    expect(isSkillLinked(link)).toBe(true);
  });
  it("filters the same location by scope, agent and status together", () => {
    const groups = groupSkills([skill(), skill({ id: "global", scope: "user", enabled: false, effectiveAgents: ["claude"] })]);
    expect(filterSkillGroups(groups, "", "claude", "workspace", "enabled")).toEqual([]);
    expect(filterSkillGroups(groups, "review", "all", "all", "all")).toHaveLength(1);
    expect(filterSkillGroups(groups, "missing", "all", "all", "all")).toEqual([]);
  });
  it("previews a shared root once and includes its additional consumers", () => {
    const catalog: SkillCatalog = { skills: [], roots: [
      { agent: "codex", scope: "workspace", enabledDir: "/project/.agents/skills" },
      { agent: "pi", scope: "workspace", enabledDir: "/project/.agents/skills" },
      { agent: "claude", scope: "workspace", enabledDir: "/project/.claude/skills" },
    ] };
    const targets = skillInstallTargets(catalog, ["codex", "pi", "claude"], "workspace");
    expect(targets).toHaveLength(2);
    expect(targets[0].consumers).toContain("opencode");
  });
  it("protects sources with linked consumers while allowing linked entry toggles", () => {
    const original = skill();
    const link = skill({ id: "link", filePath: "/link/SKILL.md", entryIsLink: true });
    const catalog = { skills: [original, link], roots: [] };
    expect(skillToggleBlocked(original, catalog)).toBe(true);
    expect(skillToggleBlocked(link, catalog)).toBe(false);
    expect(skillToggleBlocked(original, { skills: [original], roots: [] })).toBe(false);
  });
  it("protects entries reached through a linked parent directory", () => {
    const original = skill();
    const alias = skill({ id: "parent-link", filePath: "/linked-parent/review/SKILL.md" });
    const catalog = { skills: [original, alias], roots: [] };
    expect(skillToggleBlocked(alias, catalog)).toBe(true);
    expect(skillToggleBlocked(original, catalog)).toBe(true);
  });
  it("previews generated folder names and preserves imported folder names", () => {
    expect(skillFolderName("Review Checklist", null)).toBe("review-checklist");
    expect(skillFolderName("审查", null)).toBe("new-skill");
    expect(skillFolderName(`${"a".repeat(63)} separator`, null)).toBe("a".repeat(63));
    expect(skillFolderName("", "C:\\skills\\Existing_Name")).toBe("Existing_Name");
  });
  it("previews only the Markdown body while preserving incomplete source", () => {
    expect(skillMarkdownBody("\uFEFF---\r\nname: review\r\ndescription: Review\r\n---\r\n# Instructions")).toBe("# Instructions");
    expect(skillMarkdownBody("---\nname: unfinished")).toBe("---\nname: unfinished");
    expect(skillMarkdownBody("# Instructions\n---\nKeep this rule")).toBe("# Instructions\n---\nKeep this rule");
    expect(skillEditorKey("a", "file")).not.toBe(skillEditorKey("b", "file"));
  });
});
