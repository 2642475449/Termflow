import { describe, it, expect } from "vitest";
import {
  normalizeQuickCommands,
  flattenQuickCommand,
  quickCommandMatchesRepository,
  isQuickCommandComplete,
  createQuickCommandDraft,
  MAX_QUICK_COMMANDS,
} from "./quickCommands";
import { scoreQuickCommand, searchQuickCommands, normalizeSearchText } from "./quickCommandSearch";
import type { TerminalQuickCommand } from "@/types";

// ── 辅助函数 ─────────────────────────────────────────────────

function makeCommand(overrides: Partial<TerminalQuickCommand> = {}): TerminalQuickCommand {
  return {
    id: "test-cmd",
    label: "Test Command",
    scope: { type: "global" },
    action: "terminal-command",
    command: "echo hello",
    appendEnter: true,
    ...overrides,
  };
}

// ── normalizeQuickCommands ───────────────────────────────────

describe("normalizeQuickCommands", () => {
  it("returns empty array for non-array input", () => {
    expect(normalizeQuickCommands(null)).toEqual([]);
    expect(normalizeQuickCommands(undefined)).toEqual([]);
    expect(normalizeQuickCommands("string")).toEqual([]);
    expect(normalizeQuickCommands(123)).toEqual([]);
  });

  it("returns empty array for empty array", () => {
    expect(normalizeQuickCommands([])).toEqual([]);
  });

  it("skips non-object items", () => {
    expect(normalizeQuickCommands([null, 123, "str", { id: "1", label: "a", command: "b" }])).toHaveLength(1);
  });

  it("generates ID for items without one", () => {
    const result = normalizeQuickCommands([{ label: "test", command: "echo 1" }]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toMatch(/^quick-command-/);
  });

  it("deduplicates IDs", () => {
    const result = normalizeQuickCommands([
      { id: "dup", label: "a", command: "echo 1" },
      { id: "dup", label: "b", command: "echo 2" },
      { id: "dup", label: "c", command: "echo 3" },
    ]);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe("dup");
    expect(result[1].id).toBe("dup-2");
    expect(result[2].id).toBe("dup-3");
  });

  it("skips items with no label and no command", () => {
    expect(normalizeQuickCommands([{ id: "1" }])).toEqual([]);
    expect(normalizeQuickCommands([{ id: "1", label: "   ", command: "   " }])).toEqual([]);
  });

  it("preserves items with only label (incomplete drafts)", () => {
    const result = normalizeQuickCommands([{ id: "1", label: "Draft" }]);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Draft");
  });

  it("truncates fields to max length", () => {
    const longLabel = "a".repeat(100);
    const longCommand = "b".repeat(5000);
    const result = normalizeQuickCommands([
      { id: "1", label: longLabel, command: longCommand },
    ]);
    expect(result[0].label).toHaveLength(80);
    expect(result[0].command).toHaveLength(4000);
  });

  it("defaults appendEnter to true", () => {
    const result = normalizeQuickCommands([{ id: "1", label: "a", command: "b" }]);
    expect(result[0].appendEnter).toBe(true);
  });

  it("keeps appendEnter false when explicitly set", () => {
    const result = normalizeQuickCommands([
      { id: "1", label: "a", command: "b", appendEnter: false },
    ]);
    expect(result[0].appendEnter).toBe(false);
  });

  it("preserves agent prompts and defaults unknown actions to terminal commands", () => {
    const result = normalizeQuickCommands([
      {
        id: "agent",
        label: "Review",
        command: "Review this change",
        action: "agent-prompt",
        agentId: "claude",
      },
      { id: "legacy", label: "Build", command: "pnpm build", action: "unknown" },
    ]);

    expect(result[0].action).toBe("agent-prompt");
    expect(result[0].agentId).toBe("claude");
    expect(result[1].action).toBe("terminal-command");
  });

  it("drops invalid agent ids for agent prompts", () => {
    const result = normalizeQuickCommands([
      {
        id: "agent",
        label: "Review",
        command: "Review this change",
        action: "agent-prompt",
        agentId: "powershell",
      },
    ]);

    expect(result[0].agentId).toBeUndefined();
  });

  it("normalizes invalid scope to global", () => {
    const result = normalizeQuickCommands([
      { id: "1", label: "a", command: "b", scope: { type: "invalid" } },
    ]);
    expect(result[0].scope).toEqual({ type: "global" });
  });

  it("normalizes empty repositoryId to global", () => {
    const result = normalizeQuickCommands([
      { id: "1", label: "a", command: "b", scope: { type: "repository", repositoryId: "" } },
    ]);
    expect(result[0].scope).toEqual({ type: "global" });
  });

  it("preserves valid repository scope", () => {
    const result = normalizeQuickCommands([
      {
        id: "1",
        label: "a",
        command: "b",
        scope: { type: "repository", repositoryId: "/home/user/project" },
      },
    ]);
    expect(result[0].scope).toEqual({ type: "repository", repositoryId: "/home/user/project" });
  });

  it("caps at MAX_QUICK_COMMANDS", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      id: `cmd-${i}`,
      label: `Cmd ${i}`,
      command: `echo ${i}`,
    }));
    const result = normalizeQuickCommands(items);
    expect(result).toHaveLength(MAX_QUICK_COMMANDS);
  });
});

// ── flattenQuickCommand ──────────────────────────────────────

describe("flattenQuickCommand", () => {
  it("returns single line unchanged", () => {
    expect(flattenQuickCommand("pnpm dev")).toBe("pnpm dev");
  });

  it("joins multiple lines with semicolons", () => {
    expect(flattenQuickCommand("pnpm install\npnpm test")).toBe("pnpm install; pnpm test");
  });

  it("handles CRLF line endings", () => {
    expect(flattenQuickCommand("a\r\nb\r\nc")).toBe("a; b; c");
  });

  it("handles CR line endings", () => {
    expect(flattenQuickCommand("a\rb\rc")).toBe("a; b; c");
  });

  it("trims each line", () => {
    expect(flattenQuickCommand("  pnpm install  \n  pnpm test  ")).toBe("pnpm install; pnpm test");
  });

  it("removes empty lines", () => {
    expect(flattenQuickCommand("a\n\n\nb")).toBe("a; b");
  });

  it("handles all empty lines", () => {
    expect(flattenQuickCommand("\n\n\n")).toBe("");
  });
});

// ── quickCommandMatchesRepository ────────────────────────────

describe("quickCommandMatchesRepository", () => {
  it("global commands always match", () => {
    expect(quickCommandMatchesRepository(makeCommand({ scope: { type: "global" } }), null)).toBe(
      true,
    );
    expect(
      quickCommandMatchesRepository(
        makeCommand({ scope: { type: "global" } }),
        "/some/repo",
      ),
    ).toBe(true);
  });

  it("repository commands match when ID matches", () => {
    expect(
      quickCommandMatchesRepository(
        makeCommand({ scope: { type: "repository", repositoryId: "/repo-a" } }),
        "/repo-a",
      ),
    ).toBe(true);
  });

  it("repository commands don't match when ID differs", () => {
    expect(
      quickCommandMatchesRepository(
        makeCommand({ scope: { type: "repository", repositoryId: "/repo-a" } }),
        "/repo-b",
      ),
    ).toBe(false);
  });

  it("repository commands don't match when repositoryId is null", () => {
    expect(
      quickCommandMatchesRepository(
        makeCommand({ scope: { type: "repository", repositoryId: "/repo-a" } }),
        null,
      ),
    ).toBe(false);
  });
});

// ── isQuickCommandComplete ───────────────────────────────────

describe("isQuickCommandComplete", () => {
  it("returns true when label and command are non-empty", () => {
    expect(isQuickCommandComplete(makeCommand())).toBe(true);
  });

  it("returns false when label is empty", () => {
    expect(isQuickCommandComplete(makeCommand({ label: "" }))).toBe(false);
    expect(isQuickCommandComplete(makeCommand({ label: "   " }))).toBe(false);
  });

  it("returns false when command is empty", () => {
    expect(isQuickCommandComplete(makeCommand({ command: "" }))).toBe(false);
    expect(isQuickCommandComplete(makeCommand({ command: "   " }))).toBe(false);
  });

  it("returns false when agent prompt has no bound agent", () => {
    expect(isQuickCommandComplete(makeCommand({ action: "agent-prompt", agentId: undefined }))).toBe(false);
  });

  it("returns true when agent prompt binds to a supported agent", () => {
    expect(isQuickCommandComplete(makeCommand({ action: "agent-prompt", agentId: "claude" }))).toBe(true);
  });
});

// ── createQuickCommandDraft ──────────────────────────────────

describe("createQuickCommandDraft", () => {
  it("creates a draft with default global scope", () => {
    const draft = createQuickCommandDraft();
    expect(draft.id).toMatch(/^quick-command-/);
    expect(draft.label).toBe("");
    expect(draft.command).toBe("");
    expect(draft.appendEnter).toBe(true);
    expect(draft.agentId).toBeUndefined();
    expect(draft.scope).toEqual({ type: "global" });
    expect(draft.action).toBe("terminal-command");
  });

  it("creates a draft with repository scope", () => {
    const draft = createQuickCommandDraft({ type: "repository", repositoryId: "/my/repo" });
    expect(draft.scope).toEqual({ type: "repository", repositoryId: "/my/repo" });
  });
});

// ── normalizeSearchText ──────────────────────────────────────

describe("normalizeSearchText", () => {
  it("converts to lowercase", () => {
    expect(normalizeSearchText("Hello WORLD")).toBe("hello world");
  });

  it("collapses consecutive whitespace", () => {
    expect(normalizeSearchText("  hello   world  ")).toBe("hello world");
  });

  it("handles tabs and newlines", () => {
    expect(normalizeSearchText("hello\t\nworld")).toBe("hello world");
  });

  it("returns empty string for all whitespace", () => {
    expect(normalizeSearchText("   ")).toBe("");
  });
});

// ── scoreQuickCommand ────────────────────────────────────────

describe("scoreQuickCommand", () => {
  it("scores exact label match lowest", () => {
    const cmd = makeCommand({ label: "dev", command: "pnpm dev" });
    expect(scoreQuickCommand("dev", cmd)).toBe(0);
  });

  it("scores prefix label match higher than exact", () => {
    const cmd = makeCommand({ label: "dev server", command: "pnpm dev" });
    expect(scoreQuickCommand("dev", cmd)).toBe(50);
  });

  it("scores body match higher than label match", () => {
    const cmd = makeCommand({ label: "start", command: "pnpm dev" });
    const labelScore = scoreQuickCommand("start", cmd);
    const bodyScore = scoreQuickCommand("dev", cmd);
    expect(labelScore).toBeLessThan(bodyScore);
  });

  it("returns Infinity for no match", () => {
    const cmd = makeCommand({ label: "dev", command: "pnpm dev" });
    expect(scoreQuickCommand("xyz", cmd)).toBe(Number.POSITIVE_INFINITY);
  });
});

// ── searchQuickCommands ──────────────────────────────────────

describe("searchQuickCommands", () => {
  const commands = [
    makeCommand({ id: "1", label: "Dev Server", command: "pnpm dev" }),
    makeCommand({ id: "2", label: "Run Tests", command: "pnpm test" }),
    makeCommand({ id: "3", label: "Build", command: "pnpm build" }),
  ];

  it("returns all commands for empty query", () => {
    expect(searchQuickCommands("", commands)).toHaveLength(3);
  });

  it("filters by label match", () => {
    const result = searchQuickCommands("dev", commands);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Dev Server");
  });

  it("filters by body match", () => {
    const result = searchQuickCommands("test", commands);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Run Tests");
  });

  it("sorts label matches before body matches", () => {
    const cmds = [
      makeCommand({ id: "1", label: "Start", command: "pnpm dev" }),
      makeCommand({ id: "2", label: "Dev Server", command: "pnpm start" }),
    ];
    const result = searchQuickCommands("dev", cmds);
    expect(result[0].label).toBe("Dev Server");
  });

  it("skips incomplete commands", () => {
    const cmds = [
      makeCommand({ id: "1", label: "Complete", command: "echo ok" }),
      makeCommand({ id: "2", label: "", command: "" }),
    ];
    expect(searchQuickCommands("", cmds)).toHaveLength(1);
  });
});
