import { create } from "zustand";
import { useAppStore } from "@/store";
import { loadQuickCommands, loadQuickCommandCatalog, removeQuickCommand, saveQuickCommand, type QuickCommandCatalog } from "@/lib/api";
import type { QuickCommandScope, TerminalQuickCommand } from "@/types";

interface ProjectQuickCommandsState {
  loading: boolean;
  saving: boolean;
  loadedProjectPath: string | null | undefined;
  error: string | null;
  catalog: QuickCommandCatalog;
  catalogLoading: boolean;
  catalogInitialized: boolean;
  catalogError: string | null;
}

export const useProjectQuickCommandsStore = create<ProjectQuickCommandsState>(() => ({
  loading: false,
  saving: false,
  loadedProjectPath: undefined,
  error: null,
  catalog: { commands: [], errors: [] },
  catalogLoading: false,
  catalogInitialized: false,
  catalogError: null,
}));

let loadRevision = 0;
let catalogRevision = 0;
let pendingMutations = 0;
let mutationQueue: Promise<void> = Promise.resolve();

export async function refreshQuickCommandCatalog(): Promise<void> {
  const revision = ++catalogRevision;
  const state = useAppStore.getState();
  const paths = [...new Set([
    state.currentProject?.path,
    ...state.recentProjects.map((project) => project.path),
    ...Object.keys(state.projectSessions),
    ...Object.keys(state.projectArchivedSessions),
    ...Object.keys(state.projectWorkspaces),
  ].filter((path): path is string => !!path))];
  useProjectQuickCommandsStore.setState({ catalogLoading: true, catalogInitialized: true });
  try {
    const catalog = await loadQuickCommandCatalog(paths);
    if (revision !== catalogRevision) return;
    useProjectQuickCommandsStore.setState({ catalog, catalogError: null });
  } catch (error) {
    if (revision !== catalogRevision) return;
    useProjectQuickCommandsStore.setState({ catalogError: String(error) });
    throw error;
  } finally {
    if (revision === catalogRevision) useProjectQuickCommandsStore.setState({ catalogLoading: false });
  }
}

export async function loadProjectQuickCommands(projectPath: string | null): Promise<void> {
  const currentPath = () => useAppStore.getState().currentProject?.path ?? null;
  if (currentPath() !== projectPath) return;
  const revision = ++loadRevision;
  useProjectQuickCommandsStore.setState({ loading: true });
  // 切换项目时仅保留全局缓存，避免设置页显示上一项目的命令。
  if (useProjectQuickCommandsStore.getState().loadedProjectPath !== projectPath) {
    const state = useAppStore.getState();
    state.setTerminalQuickCommands(state.terminalQuickCommands.filter((command) => command.scope.type === "global"));
  }
  try {
    const commands = await loadQuickCommands(projectPath);
    if (revision !== loadRevision || currentPath() !== projectPath) return;
    useAppStore.getState().setTerminalQuickCommands(commands);
    useProjectQuickCommandsStore.setState({ loadedProjectPath: projectPath, error: null });
  } catch (error) {
    if (revision !== loadRevision || currentPath() !== projectPath) return;
    useProjectQuickCommandsStore.setState({ error: String(error) });
    throw error;
  } finally {
    if (revision === loadRevision) useProjectQuickCommandsStore.setState({ loading: false });
  }
}

function queueMutation(operation: () => Promise<void>): Promise<void> {
  pendingMutations++;
  // 正在读取的旧快照不能覆盖随后保存的结果。
  loadRevision++;
  catalogRevision++;
  useProjectQuickCommandsStore.setState({ saving: true, loading: false, catalogLoading: false });
  const result = mutationQueue.then(async () => {
    await operation();
    // 保存已落盘；若刷新失败，保留错误供界面显示，不把成功写入误报为失败。
    try {
      await loadProjectQuickCommands(useAppStore.getState().currentProject?.path ?? null);
    } catch (error) {
      console.error("Failed to reload saved quick commands:", error);
    }
    if (useProjectQuickCommandsStore.getState().catalogInitialized) {
      try {
        await refreshQuickCommandCatalog();
      } catch (error) {
        console.error("Failed to reload quick command catalog:", error);
      }
    }
  });
  mutationQueue = result.catch(() => undefined);
  return result.finally(() => {
    pendingMutations--;
    useProjectQuickCommandsStore.setState({ saving: pendingMutations > 0 });
  });
}

export function persistQuickCommand(command: TerminalQuickCommand, previousScope?: QuickCommandScope): Promise<void> {
  return queueMutation(() => saveQuickCommand(command, previousScope));
}

export function deletePersistedQuickCommand(command: TerminalQuickCommand): Promise<void> {
  return queueMutation(() => removeQuickCommand(command.id, command.scope));
}
