import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppStore } from "@/store";
import * as api from "@/lib/api";
import type { TerminalQuickCommand } from "@/types";
import { deletePersistedQuickCommand, loadProjectQuickCommands, persistQuickCommand, useProjectQuickCommandsStore } from "./projectQuickCommands";

const projectCommand: TerminalQuickCommand = { id: "project", label: "Project", action: "terminal-command", command: "pwd", appendEnter: true, scope: { type: "repository", repositoryId: "E:/A" } };
const anotherCommand: TerminalQuickCommand = { ...projectCommand, id: "another" };

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.getState().setCurrentProject({ name: "A", path: "E:/A" });
  useProjectQuickCommandsStore.setState(useProjectQuickCommandsStore.getInitialState(), true);
});
afterEach(() => vi.restoreAllMocks());

it("loads current project commands from the backend instead of the local settings cache", async () => {
  useAppStore.getState().setTerminalQuickCommands([{ ...projectCommand, id: "stale" }]);
  vi.spyOn(api, "loadQuickCommands").mockResolvedValue([anotherCommand, projectCommand]);
  await loadProjectQuickCommands("E:/A");
  expect(useAppStore.getState().terminalQuickCommands).toEqual([anotherCommand, projectCommand]);
  expect(useProjectQuickCommandsStore.getState()).toMatchObject({ loadedProjectPath: "E:/A", loading: false, error: null });
});

it("clears commands while switching projects and ignores the previous project's late response", async () => {
  let resolveA!: (commands: TerminalQuickCommand[]) => void;
  const otherProjectCommand = { ...projectCommand, scope: { type: "repository" as const, repositoryId: "E:/B" } };
  vi.spyOn(api, "loadQuickCommands").mockImplementation((path) => path === "E:/A"
    ? new Promise((resolve) => { resolveA = resolve; }) : Promise.resolve([otherProjectCommand]));
  useAppStore.getState().setTerminalQuickCommands([anotherCommand, projectCommand]);
  const first = loadProjectQuickCommands("E:/A");
  expect(useAppStore.getState().terminalQuickCommands).toEqual([]);
  useAppStore.getState().setCurrentProject({ name: "B", path: "E:/B" });
  await loadProjectQuickCommands("E:/B");
  resolveA([projectCommand]);
  await first;
  expect(useAppStore.getState().terminalQuickCommands).toEqual([otherProjectCommand]);
  expect(useProjectQuickCommandsStore.getState().loadedProjectPath).toBe("E:/B");
});

it("preserves loaded commands and reports a failed read rather than treating it as an empty file", async () => {
  useAppStore.getState().setTerminalQuickCommands([anotherCommand, projectCommand]);
  useProjectQuickCommandsStore.setState({ loadedProjectPath: "E:/A" });
  vi.spyOn(api, "loadQuickCommands").mockRejectedValue("invalid JSON");
  await expect(loadProjectQuickCommands("E:/A")).rejects.toBe("invalid JSON");
  expect(useAppStore.getState().terminalQuickCommands).toEqual([anotherCommand, projectCommand]);
  expect(useProjectQuickCommandsStore.getState()).toMatchObject({ error: "invalid JSON", loading: false });
});

it("does not report failed writes as successful or alter the command cache", async () => {
  useAppStore.getState().setTerminalQuickCommands([anotherCommand]);
  vi.spyOn(api, "saveQuickCommand").mockRejectedValue("read-only directory");
  const load = vi.spyOn(api, "loadQuickCommands");
  await expect(persistQuickCommand(projectCommand)).rejects.toBe("read-only directory");
  expect(load).not.toHaveBeenCalled();
  expect(useAppStore.getState().terminalQuickCommands).toEqual([anotherCommand]);
  expect(useProjectQuickCommandsStore.getState().saving).toBe(false);
});

it("passes the original current-project scope and refreshes after the write completes", async () => {
  const save = vi.spyOn(api, "saveQuickCommand").mockResolvedValue();
  const load = vi.spyOn(api, "loadQuickCommands").mockResolvedValue([projectCommand]);
  const previousScope = projectCommand.scope;
  await persistQuickCommand(projectCommand, previousScope);
  expect(save).toHaveBeenCalledWith(projectCommand, previousScope);
  expect(load).toHaveBeenCalledWith("E:/A");
  expect(useAppStore.getState().terminalQuickCommands).toEqual([projectCommand]);
});

it("deletes using scope as well as ID and refreshes the authoritative list", async () => {
  const remove = vi.spyOn(api, "removeQuickCommand").mockResolvedValue();
  vi.spyOn(api, "loadQuickCommands").mockResolvedValue([anotherCommand]);
  await deletePersistedQuickCommand(projectCommand);
  expect(remove).toHaveBeenCalledWith(projectCommand.id, projectCommand.scope);
  expect(useAppStore.getState().terminalQuickCommands).toEqual([anotherCommand]);
});

it("serializes overlapping edits and leaves saving active until both writes complete", async () => {
  let resolveFirst!: () => void;
  const save = vi.spyOn(api, "saveQuickCommand").mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; })).mockResolvedValue();
  vi.spyOn(api, "loadQuickCommands").mockResolvedValue([anotherCommand, projectCommand]);
  const first = persistQuickCommand(anotherCommand);
  const second = persistQuickCommand(projectCommand);
  await Promise.resolve();
  expect(save).toHaveBeenCalledTimes(1);
  expect(useProjectQuickCommandsStore.getState().saving).toBe(true);
  resolveFirst();
  await Promise.all([first, second]);
  expect(save).toHaveBeenCalledTimes(2);
  expect(useProjectQuickCommandsStore.getState().saving).toBe(false);
});

it("reads only the current folder even when other projects are known", async () => {
  useAppStore.getState().setRecentProjects([{ name: "B", path: "E:/B", lastOpenedAt: 1 }]);
  useAppStore.setState({ projectArchivedSessions: { "E:/Archived": [] } });
  useAppStore.getState().setTerminalQuickCommands([projectCommand]);
  const other = { ...projectCommand, scope: { type: "repository" as const, repositoryId: "E:/B" } };
  const load = vi.spyOn(api, "loadQuickCommands").mockResolvedValue([projectCommand, other]);
  const catalog = vi.spyOn(api, "loadQuickCommandCatalog");
  await loadProjectQuickCommands("E:/A");
  expect(load.mock.calls).toEqual([["E:/A"]]);
  expect(catalog).not.toHaveBeenCalled();
  expect(useAppStore.getState().terminalQuickCommands).toEqual([projectCommand]);
});

it("clears the previous folder's error before a new folder finishes loading", async () => {
  useProjectQuickCommandsStore.setState({ loadedProjectPath: "E:/A", error: "A is unavailable" });
  useAppStore.getState().setCurrentProject({ name: "B", path: "E:/B" });
  let resolveB!: (commands: TerminalQuickCommand[]) => void;
  vi.spyOn(api, "loadQuickCommands").mockImplementation(() => new Promise((resolve) => { resolveB = resolve; }));
  const pending = loadProjectQuickCommands("E:/B");
  expect(useProjectQuickCommandsStore.getState()).toMatchObject({ loadedProjectPath: "E:/B", error: null, loading: true });
  resolveB([]);
  await pending;
});

it("ignores a late read failure from the previous project", async () => {
  let rejectA!: (reason: string) => void;
  vi.spyOn(api, "loadQuickCommands").mockImplementationOnce(() => new Promise((_, reject) => { rejectA = reject; })).mockResolvedValue([]);
  const pending = loadProjectQuickCommands("E:/A");
  useAppStore.getState().setCurrentProject({ name: "B", path: "E:/B" });
  await loadProjectQuickCommands("E:/B");
  rejectA("A is unavailable");
  await pending;
  expect(useProjectQuickCommandsStore.getState()).toMatchObject({ loadedProjectPath: "E:/B", error: null, loading: false });
});

it("rejects saving or deleting another project's command before calling the backend", async () => {
  const other = { ...projectCommand, scope: { type: "repository" as const, repositoryId: "E:/B" } };
  const save = vi.spyOn(api, "saveQuickCommand").mockResolvedValue();
  const remove = vi.spyOn(api, "removeQuickCommand").mockResolvedValue();
  await expect(persistQuickCommand(other)).rejects.toThrow();
  await expect(persistQuickCommand(projectCommand, other.scope)).rejects.toThrow();
  await expect(deletePersistedQuickCommand(other)).rejects.toThrow();
  expect(save).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(useProjectQuickCommandsStore.getState().saving).toBe(false);
});

it("rejects a queued edit after switching to a different folder", async () => {
  let finishSave!: () => void;
  const save = vi.spyOn(api, "saveQuickCommand").mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
  vi.spyOn(api, "loadQuickCommands").mockResolvedValue([]);
  const first = persistQuickCommand(projectCommand);
  const queued = persistQuickCommand(anotherCommand);
  const rejected = expect(queued).rejects.toThrow();
  await Promise.resolve();
  useAppStore.getState().setCurrentProject({ name: "B", path: "E:/B" });
  finishSave();
  await first;
  await rejected;
  expect(save).toHaveBeenCalledTimes(1);
});

it("does not interrupt the active folder's read when rejecting a stale write", async () => {
  let resolve!: (commands: TerminalQuickCommand[]) => void;
  vi.spyOn(api, "loadQuickCommands").mockImplementation(() => new Promise((done) => { resolve = done; }));
  const pending = loadProjectQuickCommands("E:/A");
  const other = { ...projectCommand, scope: { type: "repository" as const, repositoryId: "E:/B" } };
  await expect(persistQuickCommand(other)).rejects.toThrow();
  expect(useProjectQuickCommandsStore.getState().loading).toBe(true);
  resolve([projectCommand]);
  await pending;
  expect(useAppStore.getState().terminalQuickCommands).toEqual([projectCommand]);
});

it("does not expose cached commands after closing the current project", async () => {
  useAppStore.getState().setTerminalQuickCommands([projectCommand]);
  useProjectQuickCommandsStore.setState({ loadedProjectPath: "E:/A" });
  useAppStore.setState({ currentProject: null });
  const load = vi.spyOn(api, "loadQuickCommands").mockResolvedValue([]);
  await loadProjectQuickCommands(null);
  expect(useAppStore.getState().terminalQuickCommands).toEqual([]);
  expect(useProjectQuickCommandsStore.getState().loadedProjectPath).toBeNull();
  expect(load).not.toHaveBeenCalled();
});

it("does not accept commands from another project into the active terminal cache", async () => {
  const other = { ...projectCommand, scope: { type: "repository" as const, repositoryId: "E:/B" } };
  vi.spyOn(api, "loadQuickCommands").mockResolvedValue([projectCommand, other]);
  await loadProjectQuickCommands("E:/A");
  expect(useAppStore.getState().terminalQuickCommands).toEqual([projectCommand]);
});
