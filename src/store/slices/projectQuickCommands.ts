import { create } from "zustand";
import { useAppStore } from "@/store";
import { loadQuickCommands, removeQuickCommand, saveQuickCommand } from "@/lib/api";
import i18n from "@/i18n";
import type { QuickCommandScope, TerminalQuickCommand } from "@/types";
import { quickCommandMatchesRepository } from "@/lib/quickCommands";

interface ProjectQuickCommandsState {
  loading: boolean;
  saving: boolean;
  loadedProjectPath: string | null | undefined;
  error: string | null;
}

export const useProjectQuickCommandsStore = create<ProjectQuickCommandsState>(() => ({
  loading: false,
  saving: false,
  loadedProjectPath: undefined,
  error: null,
}));

let loadRevision = 0;
let pendingMutations = 0;
let mutationQueue: Promise<void> = Promise.resolve();

export async function loadProjectQuickCommands(projectPath: string | null): Promise<void> {
  const currentPath = () => useAppStore.getState().currentProject?.path ?? null;
  if (currentPath() !== projectPath) return;
  const revision = ++loadRevision;
  // 切换项目立即清空缓存，避免终端使用上一项目的命令。
  if (useProjectQuickCommandsStore.getState().loadedProjectPath !== projectPath) {
    useAppStore.getState().setTerminalQuickCommands([]);
  }
  // 错误和缓存同属当前项目，不能把上个项目的错误带到新项目。
  useProjectQuickCommandsStore.setState({ loadedProjectPath: projectPath, loading: projectPath !== null, error: null });
  if (projectPath === null) return;
  try {
    const commands = await loadQuickCommands(projectPath);
    if (revision !== loadRevision || currentPath() !== projectPath) return;
    useAppStore.getState().setTerminalQuickCommands(
      commands.filter((command) => quickCommandMatchesRepository(command, projectPath)),
    );
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
  useProjectQuickCommandsStore.setState({ saving: true, loading: false });
  const result = mutationQueue.then(async () => {
    await operation();
    // 保存已落盘；若刷新失败，保留错误供界面显示，不把成功写入误报为失败。
    try {
      await loadProjectQuickCommands(useAppStore.getState().currentProject?.path ?? null);
    } catch (error) {
      console.error("Failed to reload saved quick commands:", error);
    }
  });
  mutationQueue = result.catch(() => undefined);
  return result.finally(() => {
    pendingMutations--;
    useProjectQuickCommandsStore.setState({ saving: pendingMutations > 0 });
  });
}

export async function persistQuickCommand(command: TerminalQuickCommand, previousScope?: QuickCommandScope): Promise<void> {
  // 先拒绝过期操作，避免使当前项目正在进行的读取失效；排队执行前再次检查。
  assertCurrentProject(command);
  if (previousScope) assertCurrentProject({ ...command, scope: previousScope });
  return queueMutation(() => {
    assertCurrentProject(command);
    if (previousScope) assertCurrentProject({ ...command, scope: previousScope });
    return saveQuickCommand(command, previousScope);
  });
}

export async function deletePersistedQuickCommand(command: TerminalQuickCommand): Promise<void> {
  assertCurrentProject(command);
  return queueMutation(() => {
    assertCurrentProject(command);
    return removeQuickCommand(command.id, command.scope);
  });
}

function assertCurrentProject(command: TerminalQuickCommand): void {
  if (!quickCommandMatchesRepository(command, useAppStore.getState().currentProject?.path ?? null)) {
    throw new Error(i18n.t("quickCommands.projectChanged"));
  }
}
