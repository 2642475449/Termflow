import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppStore } from "@/store";
import * as api from "@/lib/api";
import type { TerminalQuickCommand } from "@/types";
import { deletePersistedQuickCommand, loadProjectQuickCommands, persistQuickCommand, refreshQuickCommandCatalog, useProjectQuickCommandsStore } from "./projectQuickCommands";

const globalCommand: TerminalQuickCommand = { id: "global", label: "Global", action: "terminal-command", command: "pwd", appendEnter: true, scope: { type: "global" } };
const projectCommand: TerminalQuickCommand = { ...globalCommand, id: "project", scope: { type: "repository", repositoryId: "E:/A" } };

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.getState().setCurrentProject({ name: "A", path: "E:/A" });
  useProjectQuickCommandsStore.setState(useProjectQuickCommandsStore.getInitialState(), true);
});
afterEach(() => vi.restoreAllMocks());

it("loads globals and current project from the backend instead of the local settings cache", async () => {
  useAppStore.getState().setTerminalQuickCommands([{ ...projectCommand, id: "stale" }]);
  vi.spyOn(api, "loadQuickCommands").mockResolvedValue([globalCommand, projectCommand]);
  await loadProjectQuickCommands("E:/A");
  expect(useAppStore.getState().terminalQuickCommands).toEqual([globalCommand, projectCommand]);
  expect(useProjectQuickCommandsStore.getState()).toMatchObject({ loadedProjectPath: "E:/A", loading: false, error: null });
});

it("ignores a stale response after switching project and keeps global commands while loading", async () => {
  let resolveA!: (commands: TerminalQuickCommand[]) => void;
  vi.spyOn(api, "loadQuickCommands").mockImplementation((path) => path === "E:/A"
    ? new Promise((resolve) => { resolveA = resolve; }) : Promise.resolve([globalCommand]));
  useAppStore.getState().setTerminalQuickCommands([globalCommand, projectCommand]);
  const first = loadProjectQuickCommands("E:/A");
  expect(useAppStore.getState().terminalQuickCommands).toEqual([globalCommand]);
  useAppStore.getState().setCurrentProject({ name: "B", path: "E:/B" });
  await loadProjectQuickCommands("E:/B");
  resolveA([projectCommand]);
  await first;
  expect(useAppStore.getState().terminalQuickCommands).toEqual([globalCommand]);
  expect(useProjectQuickCommandsStore.getState().loadedProjectPath).toBe("E:/B");
});

it("preserves loaded commands and reports a failed read rather than treating it as an empty file", async () => {
  useAppStore.getState().setTerminalQuickCommands([globalCommand, projectCommand]);
  useProjectQuickCommandsStore.setState({ loadedProjectPath: "E:/A" });
  vi.spyOn(api, "loadQuickCommands").mockRejectedValue("invalid JSON");
  await expect(loadProjectQuickCommands("E:/A")).rejects.toBe("invalid JSON");
  expect(useAppStore.getState().terminalQuickCommands).toEqual([globalCommand, projectCommand]);
  expect(useProjectQuickCommandsStore.getState()).toMatchObject({ error: "invalid JSON", loading: false });
});

it("does not report failed writes as successful or alter the command cache", async () => {
  useAppStore.getState().setTerminalQuickCommands([globalCommand]);
  vi.spyOn(api, "saveQuickCommand").mockRejectedValue("read-only directory");
  const load = vi.spyOn(api, "loadQuickCommands");
  await expect(persistQuickCommand(projectCommand)).rejects.toBe("read-only directory");
  expect(load).not.toHaveBeenCalled();
  expect(useAppStore.getState().terminalQuickCommands).toEqual([globalCommand]);
  expect(useProjectQuickCommandsStore.getState().saving).toBe(false);
});

it("passes the original scope when moving a command and refreshes after the write completes", async () => {
  const save = vi.spyOn(api, "saveQuickCommand").mockResolvedValue();
  const load = vi.spyOn(api, "loadQuickCommands").mockResolvedValue([projectCommand]);
  await persistQuickCommand(projectCommand, { type: "global" });
  expect(save).toHaveBeenCalledWith(projectCommand, { type: "global" });
  expect(load).toHaveBeenCalledWith("E:/A");
  expect(useAppStore.getState().terminalQuickCommands).toEqual([projectCommand]);
});

it("deletes using scope as well as ID and refreshes the authoritative list", async () => {
  const remove = vi.spyOn(api, "removeQuickCommand").mockResolvedValue();
  vi.spyOn(api, "loadQuickCommands").mockResolvedValue([globalCommand]);
  await deletePersistedQuickCommand(projectCommand);
  expect(remove).toHaveBeenCalledWith(projectCommand.id, projectCommand.scope);
  expect(useAppStore.getState().terminalQuickCommands).toEqual([globalCommand]);
});

it("serializes overlapping edits and leaves saving active until both writes complete", async () => {
  let resolveFirst!: () => void;
  const save = vi.spyOn(api, "saveQuickCommand").mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; })).mockResolvedValue();
  vi.spyOn(api, "loadQuickCommands").mockResolvedValue([globalCommand, projectCommand]);
  const first = persistQuickCommand(globalCommand);
  const second = persistQuickCommand(projectCommand);
  await Promise.resolve();
  expect(save).toHaveBeenCalledTimes(1);
  expect(useProjectQuickCommandsStore.getState().saving).toBe(true);
  resolveFirst();
  await Promise.all([first, second]);
  expect(save).toHaveBeenCalledTimes(2);
  expect(useProjectQuickCommandsStore.getState().saving).toBe(false);
});

it("aggregates known project paths while leaving the current terminal command list independent", async () => {
  useAppStore.getState().setRecentProjects([{ name: "B", path: "E:/B", lastOpenedAt: 1 }]);
  useAppStore.setState({ projectArchivedSessions: { "E:/Archived": [] } });
  useAppStore.getState().setTerminalQuickCommands([projectCommand]);
  const other = { ...projectCommand, scope: { type: "repository" as const, repositoryId: "E:/B" } };
  const load = vi.spyOn(api, "loadQuickCommandCatalog").mockResolvedValue({ commands: [globalCommand, projectCommand, other], errors: [] });
  await refreshQuickCommandCatalog();
  expect(load).toHaveBeenCalledWith(expect.arrayContaining(["E:/A", "E:/B", "E:/Archived"]));
  expect(useProjectQuickCommandsStore.getState().catalog.commands).toEqual([globalCommand, projectCommand, other]);
  expect(useAppStore.getState().terminalQuickCommands).toEqual([projectCommand]);
});

it("retains available projects and exposes individual project read failures", async () => {
  const result = { commands: [projectCommand], errors: [{ projectPath: "E:/B", error: "invalid JSON" }] };
  vi.spyOn(api, "loadQuickCommandCatalog").mockResolvedValue(result);
  await refreshQuickCommandCatalog();
  expect(useProjectQuickCommandsStore.getState()).toMatchObject({ catalog: result, catalogError: null, catalogLoading: false });
});

it("ignores outdated catalog responses instead of restoring deleted commands", async () => {
  let resolveOld!: (catalog: api.QuickCommandCatalog) => void;
  vi.spyOn(api, "loadQuickCommandCatalog").mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
    .mockResolvedValue({ commands: [], errors: [] });
  const old = refreshQuickCommandCatalog();
  await refreshQuickCommandCatalog();
  resolveOld({ commands: [projectCommand], errors: [] });
  await old;
  expect(useProjectQuickCommandsStore.getState().catalog.commands).toEqual([]);
});

it("refreshes the settings catalog after editing a different project without moving its scope", async () => {
  const other = { ...projectCommand, scope: { type: "repository" as const, repositoryId: "E:/B" } };
  const loadCatalog = vi.spyOn(api, "loadQuickCommandCatalog").mockResolvedValue({ commands: [other], errors: [] });
  await refreshQuickCommandCatalog();
  const save = vi.spyOn(api, "saveQuickCommand").mockResolvedValue();
  vi.spyOn(api, "loadQuickCommands").mockResolvedValue([projectCommand]);
  await persistQuickCommand(other, other.scope);
  expect(save).toHaveBeenCalledWith(other, { type: "repository", repositoryId: "E:/B" });
  expect(loadCatalog).toHaveBeenCalledTimes(2);
  expect(useAppStore.getState().terminalQuickCommands).toEqual([projectCommand]);
  expect(useProjectQuickCommandsStore.getState().catalog.commands).toEqual([other]);
});

it("retains the last catalog on an overall load failure", async () => {
  const catalog = { commands: [globalCommand, projectCommand], errors: [] };
  useProjectQuickCommandsStore.setState({ catalog });
  vi.spyOn(api, "loadQuickCommandCatalog").mockRejectedValue("database unavailable");
  await expect(refreshQuickCommandCatalog()).rejects.toBe("database unavailable");
  expect(useProjectQuickCommandsStore.getState()).toMatchObject({ catalog, catalogError: "database unavailable", catalogLoading: false });
});
