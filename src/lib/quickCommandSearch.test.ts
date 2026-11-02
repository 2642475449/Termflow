import { expect, it } from "vitest";
import type { TerminalQuickCommand } from "@/types";
import { searchQuickCommands } from "./quickCommandSearch";

const project = "E:/project";
const preview: TerminalQuickCommand = {
  id: "preview", label: "Preview", command: "pnpm tauri dev", action: "terminal-command", appendEnter: true,
  scope: { type: "repository", repositoryId: project },
};
const build: TerminalQuickCommand = { ...preview, id: "build", label: "Build", command: "pnpm tauri build" };

it("puts the most recently used command first without changing the source list", () => {
  const commands = [preview, build];
  expect(searchQuickCommands("", commands, { [project]: { preview: 100, build: 200 } })).toEqual([build, preview]);
  expect(commands).toEqual([preview, build]);
});

it("keeps unused commands and equal timestamps in the original order", () => {
  const unused = { ...preview, id: "unused" };
  expect(searchQuickCommands("", [unused, preview, build], { [project]: { preview: 100, build: 100 } }))
    .toEqual([preview, build, unused]);
  expect(searchQuickCommands(" \t", [preview, build])).toEqual([preview, build]);
});

it("uses recency to break matching ties while preserving search relevance", () => {
  const usage = { [project]: { preview: 200, build: 100 } };
  expect(searchQuickCommands("pnpm", [build, preview], usage)).toEqual([preview, build]);
  const exact = { ...build, label: "pnpm" };
  expect(searchQuickCommands("pnpm", [preview, exact], usage)).toEqual([exact, preview]);
});

it("isolates identical command IDs in different projects and ignores removed commands", () => {
  const other = { ...build, scope: { type: "repository" as const, repositoryId: "E:/other" } };
  expect(searchQuickCommands("", [preview, build, other], {
    [project]: { preview: 100, build: 200, removed: 1000 }, "E:/other": { build: 50 },
  })).toEqual([build, preview, other]);
});

it("treats IDs that match object properties as unused until recorded", () => {
  const command = { ...preview, id: "constructor" };
  expect(searchQuickCommands("", [command, build], { [project]: { build: 10 } })).toEqual([build, command]);
});
