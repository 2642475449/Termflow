import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppStore } from "@/store";
import * as api from "@/lib/api";
import type { ProjectLauncherFile } from "@/lib/projectLaunchers";
import { loadLaunchers, persistLaunchers, resetLaunchersProject, runLauncher, useProjectLaunchersStore } from "./projectLaunchers";

const document: ProjectLauncherFile = { version: 1, launchers: [{ id: "dev", name: "Dev", terminals: [
  { title: "UI", directory: ".", command: "pnpm dev" },
  { title: "Rust", directory: "src-tauri", command: "" },
] }] };

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.getState().setCurrentProject({ name: "A", path: "E:/A" });
  useProjectLaunchersStore.setState(useProjectLaunchersStore.getInitialState(), true);
  vi.spyOn(api, "loadProjectLaunchers").mockResolvedValue(document);
  vi.spyOn(api, "prepareProjectLauncher").mockResolvedValue(document.launchers[0].terminals.map((terminal) => ({ ...terminal, directory: `E:/A/${terminal.directory}` })));
  vi.spyOn(api, "spawnPty").mockResolvedValue(undefined);
  vi.spyOn(api, "closePty").mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

it("loads and saves without starting terminals", async () => {
  const save = vi.spyOn(api, "saveProjectLaunchers").mockResolvedValue(undefined);
  await loadLaunchers("E:/A");
  expect(await persistLaunchers()).toBe(true);
  expect(save).toHaveBeenCalledWith("E:/A", document);
  expect(api.spawnPty).not.toHaveBeenCalled();
});

it("ignores a previous project's delayed load", async () => {
  let finish!: (value: ProjectLauncherFile) => void;
  vi.mocked(api.loadProjectLaunchers).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const pending = loadLaunchers("E:/A");
  await loadLaunchers("E:/B");
  finish({ version: 1, launchers: [] });
  await pending;
  expect(useProjectLaunchersStore.getState()).toMatchObject({ projectPath: "E:/B", document });
});

it("blocks saving unreadable config and preserves a draft after a failed write", async () => {
  vi.mocked(api.loadProjectLaunchers).mockRejectedValueOnce("invalid JSON");
  const save = vi.spyOn(api, "saveProjectLaunchers").mockRejectedValue("read-only");
  await loadLaunchers("E:/A");
  expect(await persistLaunchers()).toBe(false);
  expect(save).not.toHaveBeenCalled();
  await loadLaunchers("E:/A");
  const draft = useProjectLaunchersStore.getState().draft;
  await expect(persistLaunchers()).rejects.toBe("read-only");
  expect(useProjectLaunchersStore.getState()).toMatchObject({ draft, saving: false });
});

it("invalidates a pending load when the project closes without opening another launcher", async () => {
  let finish!: (value: ProjectLauncherFile) => void;
  vi.mocked(api.loadProjectLaunchers).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const pending = loadLaunchers("E:/A");
  resetLaunchersProject();
  finish(document);
  await pending;
  expect(useProjectLaunchersStore.getState()).toMatchObject({ projectPath: null, loading: false, document: { version: 1, launchers: [] } });
});

it("checks all directories before creating any terminal", async () => {
  await loadLaunchers("E:/A");
  vi.mocked(api.prepareProjectLauncher).mockRejectedValue("missing directory");
  await expect(runLauncher(document.launchers[0])).rejects.toBe("missing directory");
  expect(api.spawnPty).not.toHaveBeenCalled();
  expect(useAppStore.getState().sessions).toHaveLength(0);
});

it("creates fresh ephemeral terminals using the local shell and prepared directories", async () => {
  await loadLaunchers("E:/A");
  await runLauncher(document.launchers[0]);
  const sessions = useAppStore.getState().sessions;
  expect(sessions).toHaveLength(2);
  expect(sessions.every((session) => session.ephemeral && session.active && session.path === "E:/A")).toBe(true);
  expect(new Set(sessions.map((session) => session.id)).size).toBe(2);
  expect(api.spawnPty).toHaveBeenCalledWith(expect.any(String), "E:/A", false, false, "", undefined, useAppStore.getState().defaultTerminalShell, undefined, useAppStore.getState().defaultTerminalShell, "E:/A/src-tauri");
});

it("closes terminals created by a failed launch while preserving existing sessions", async () => {
  await loadLaunchers("E:/A");
  useAppStore.getState().addSession({ id: "existing", name: "Existing", path: "E:/A", active: true, createdAt: 1 });
  vi.mocked(api.spawnPty).mockResolvedValueOnce(undefined).mockRejectedValueOnce("spawn failed");
  await expect(runLauncher(document.launchers[0])).rejects.toBe("spawn failed");
  expect(api.closePty).toHaveBeenCalledTimes(2);
  expect(api.closePty).not.toHaveBeenCalledWith("existing");
  expect(useAppStore.getState().sessions.filter((session) => session.id !== "existing").every((session) => !session.active && session.status === "error")).toBe(true);
});

it("prevents duplicate clicks and stops creating terminals after a project switch", async () => {
  await loadLaunchers("E:/A");
  let finish!: () => void;
  vi.mocked(api.spawnPty).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const pending = runLauncher(document.launchers[0]);
  await vi.waitFor(() => expect(api.spawnPty).toHaveBeenCalledTimes(1));
  await runLauncher(document.launchers[0]);
  expect(api.prepareProjectLauncher).toHaveBeenCalledTimes(1);
  useAppStore.getState().setCurrentProject({ name: "B", path: "E:/B" });
  finish();
  await expect(pending).rejects.toThrow();
  expect(api.spawnPty).toHaveBeenCalledTimes(1);
  expect(api.closePty).toHaveBeenCalledTimes(1);
  expect(useAppStore.getState().projectSessions["E:/A"].every((session) => !session.active)).toBe(true);
  expect(useProjectLaunchersStore.getState().running).toBe(false);
});
