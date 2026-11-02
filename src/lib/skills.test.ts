import { describe, expect, it } from "vitest";
import type { SkillCatalog, SkillInfo } from "@/types";
import { filterSkillGroups, getSkillLibraryView, groupSkills, isSkillLinked, skillConsumers, skillEditorKey, skillMarkdownBody, skillFolderName, skillInstallTargets, skillToggleBlocked } from "./skills";

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
  it("keeps agent scope counts consistent with the screenshot's shared and native skills", () => {
    const shared = ["design", "docs", "release", "interactions"].map((name) => skill({
      id: name, name, folderName: name, effectiveAgents: skillConsumers("codex", "workspace"),
      filePath: `/project/.agents/skills/${name}/SKILL.md`, resolvedFilePath: `/project/.agents/skills/${name}/SKILL.md`,
    }));
    const native = (scope: "workspace" | "user") => skill({
      id: `claude:${scope}`, agent: "claude", scope, effectiveAgents: skillConsumers("claude", scope),
      filePath: `/${scope}/.claude/skills/release/SKILL.md`, resolvedFilePath: `/${scope}/.claude/skills/release/SKILL.md`,
    });
    const groups = groupSkills([...shared, native("workspace"), native("user")]);
    expect(getSkillLibraryView(groups, "", "all", "all", "all").counts)
      .toEqual({ all: 6, workspace: 5, user: 1 });
    const antigravity = getSkillLibraryView(groups, "", "antigravity", "workspace", "all");
    expect(antigravity.counts).toEqual({ all: 4, workspace: 4, user: 0 });
    expect(antigravity.groups.map((group) => group.skill.name)).toEqual(["design", "docs", "release", "interactions"]);
    expect(getSkillLibraryView(groups, "", "antigravity", "user", "all").groups).toEqual([]);
    expect(getSkillLibraryView(groups, "", "claude", "all", "all").counts)
      .toEqual({ all: 2, workspace: 1, user: 1 });
    expect(getSkillLibraryView(groups, "", "qoder", "all", "all").counts)
      .toEqual({ all: 0, workspace: 0, user: 0 });
    expect(getSkillLibraryView(groups, "", "opencode", "all", "all").groups).toHaveLength(6);
  });
  it("counts each linked file once per matching scope and uses the matching representative", () => {
    const original = skill({ effectiveAgents: ["codex"] });
    const alias = skill({
      id: "alias", agent: "claude", scope: "user", enabled: false, effectiveAgents: ["claude"],
      folderName: "private-alias", filePath: "/user/.claude/skills/private-alias/SKILL.md",
    });
    const groups = groupSkills([original, alias]);
    expect(getSkillLibraryView(groups, "", "all", "all", "all").counts)
      .toEqual({ all: 1, workspace: 1, user: 1 });
    const disabled = getSkillLibraryView(groups, "", "claude", "user", "disabled");
    expect(disabled.counts).toEqual({ all: 1, workspace: 0, user: 1 });
    expect(disabled.groups[0].skill).toBe(alias);
    expect(disabled.groups[0].locations).toEqual([alias]);
    expect(getSkillLibraryView(groups, "", "claude", "workspace", "enabled").groups).toEqual([]);
    expect(groups[0].skill).toBe(original);
    expect(groups[0].locations).toEqual([original, alias]);
  });
  it("applies search to each location before deriving scope counts", () => {
    const groups = groupSkills([skill(), skill({
      id: "alias", scope: "user", folderName: "private-alias", filePath: "/user/entry/SKILL.md",
    })]);
    const view = getSkillLibraryView(groups, "  PRIVATE-ALIAS  ", "all", "all", "all");
    expect(view.counts).toEqual({ all: 1, workspace: 0, user: 1 });
    expect(view.groups[0].locations).toHaveLength(1);
    expect(view.groups[0].skill.scope).toBe("user");
    expect(getSkillLibraryView(groups, "PRIVATE-ALIAS", "all", "workspace", "all").groups).toEqual([]);
    expect(getSkillLibraryView(groups, "missing", "all", "all", "all").counts)
      .toEqual({ all: 0, workspace: 0, user: 0 });
  });
  it("keeps status counts and rows aligned for every scope and agent", () => {
    const groups = groupSkills([
      skill(),
      skill({ id: "disabled", enabled: false, filePath: "/disabled/SKILL.md", resolvedFilePath: "/disabled/SKILL.md" }),
      skill({ id: "global", scope: "user", filePath: "/user/SKILL.md", resolvedFilePath: "/user/SKILL.md" }),
    ]);
    for (const agent of ["all", "codex", "claude"] as const) {
      for (const status of ["all", "enabled", "disabled"] as const) {
        for (const scope of ["all", "workspace", "user"] as const) {
          const view = getSkillLibraryView(groups, "review", agent, scope, status);
          expect(view.counts[scope]).toBe(view.groups.length);
        }
      }
    }
    expect(getSkillLibraryView(groups, "", "codex", "all", "disabled").counts)
      .toEqual({ all: 1, workspace: 1, user: 0 });
    expect(getSkillLibraryView(groups, "", "codex", "all", "enabled").counts)
      .toEqual({ all: 2, workspace: 1, user: 1 });
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
