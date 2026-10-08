import { create } from "zustand";
import i18n from "@/i18n";
import { useAppStore } from "@/store";
import { closePty, loadProjectLaunchers, prepareProjectLauncher, saveProjectLaunchers, spawnPty } from "@/lib/api";
import { createLauncherExample, type ProjectLauncher, type ProjectLauncherFile } from "@/lib/projectLaunchers";

interface ProjectLaunchersState {
  projectPath: string | null;
  document: ProjectLauncherFile;
  draft: string;
  loading: boolean;
  saving: boolean;
  running: boolean;
  error: string | null;
  setDraft: (draft: string) => void;
}

export const useProjectLaunchersStore = create<ProjectLaunchersState>((set) => ({
  projectPath: null,
  document: { version: 1, launchers: [] },
  draft: "",
  loading: false,
  saving: false,
  running: false,
  error: null,
  setDraft: (draft) => set({ draft }),
}));

let loadRevision = 0;

export function resetLaunchersProject(): void {
  ++loadRevision;
  useProjectLaunchersStore.setState({ projectPath: null, document: { version: 1, launchers: [] }, draft: "", loading: false, error: null });
}

export async function loadLaunchers(projectPath: string): Promise<void> {
  const revision = ++loadRevision;
  useProjectLaunchersStore.setState({ projectPath, document: { version: 1, launchers: [] }, draft: "", loading: true, error: null });
  try {
    const document = await loadProjectLaunchers(projectPath);
    if (revision === loadRevision) {
      useProjectLaunchersStore.setState({ document, draft: JSON.stringify(document, null, 2) });
    }
  } catch (error) {
    if (revision === loadRevision) useProjectLaunchersStore.setState({ error: String(error) });
  } finally {
    if (revision === loadRevision) useProjectLaunchersStore.setState({ loading: false });
  }
}

export function insertLauncherExample(name: string, terminalTitle: string): void {
  const state = useProjectLaunchersStore.getState();
  if (state.document.launchers.length) return;
  state.setDraft(JSON.stringify(createLauncherExample(name, terminalTitle), null, 2));
}

export async function persistLaunchers(): Promise<boolean> {
  const state = useProjectLaunchersStore.getState();
  if (!state.projectPath || state.loading || state.saving || state.running || state.error) return false;
  const revision = loadRevision;
  useProjectLaunchersStore.setState({ saving: true });
  try {
    const document: unknown = JSON.parse(state.draft);
    await saveProjectLaunchers(state.projectPath, document);
    if (revision !== loadRevision) return false;
    await loadLaunchers(state.projectPath);
    return !useProjectLaunchersStore.getState().error;
  } finally {
    useProjectLaunchersStore.setState({ saving: false });
  }
}

export async function runLauncher(launcher: ProjectLauncher): Promise<void> {
  const state = useProjectLaunchersStore.getState();
  const projectPath = state.projectPath;
  if (!projectPath || state.running || state.loading || state.saving) return;
  const revision = loadRevision;
  const isCurrent = () => revision === loadRevision && useAppStore.getState().currentProject?.path === projectPath;
  if (!isCurrent()) return;
  useProjectLaunchersStore.setState({ running: true });
  const created: string[] = [];
  try {
    const terminals = await prepareProjectLauncher(projectPath, launcher);
    const shell = useAppStore.getState().defaultTerminalShell;
    for (const terminal of terminals) {
      if (!isCurrent()) throw new Error(i18n.t("projectLaunchers.projectChanged"));
      const id = crypto.randomUUID();
      created.push(id);
      useAppStore.getState().addSession({
        id, path: projectPath, name: terminal.title, createdAt: Date.now(),
        active: false, ephemeral: true, hasPromptHistory: false,
        status: "starting", titleSource: "manual", agentId: shell,
        terminalWorkingDirectory: terminal.directory,
      });
      await spawnPty(id, projectPath, false, false, terminal.command, undefined, shell, undefined, shell, terminal.directory);
      if (!isCurrent()) throw new Error(i18n.t("projectLaunchers.projectChanged"));
      useAppStore.getState().updateSession(id, { active: true, status: terminal.command ? "running" : "waiting" });
    }
  } catch (error) {
    // 清理本次创建的终端，不影响原有会话；命令产生的外部效果无法回滚。
    await Promise.all(created.map(async (id) => {
      try { await closePty(id); } catch (cleanupError) { console.error("Launcher terminal cleanup failed", cleanupError); }
      if (useAppStore.getState().currentProject?.path === projectPath) {
        useAppStore.getState().updateSession(id, { active: false, status: "error" });
      } else {
        useAppStore.setState((current) => ({
          projectSessions: {
            ...current.projectSessions,
            [projectPath]: (current.projectSessions[projectPath] ?? []).map((session) =>
              session.id === id ? { ...session, active: false, status: "error" as const } : session),
          },
        }));
      }
    }));
    throw error;
  } finally {
    useProjectLaunchersStore.setState({ running: false });
  }
}
