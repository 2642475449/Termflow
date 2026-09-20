import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { listScheduledTaskRuns, listScheduledTasks, runScheduledTaskNow } from "@/lib/api";
import { SCHEDULED_TASKS_CHANGED_EVENT } from "@/lib/scheduledTasks";
import type { ScheduledTask, ScheduledTaskRun } from "@/types";

export type ScheduledTaskScope = "current" | "all" | string;
export type ScheduledTaskEditor = "create" | string | null;

interface ScheduledTaskState {
  tasks: ScheduledTask[];
  runs: ScheduledTaskRun[];
  loading: boolean;
  initialized: boolean;
  error: string | null;
  scope: ScheduledTaskScope;
  selectedRunId: string | null;
  editor: ScheduledTaskEditor;
  showAllRuns: boolean;
  pendingRunTaskIds: string[];
  listScrollPositions: Record<string, number>;
  expandedProjectPaths: string[];
  setShowAllRuns: (visible: boolean) => void;
  setListScrollPosition: (scopeKey: string, position: number) => void;
  toggleProjectExpanded: (projectPath: string) => void;
  setScope: (scope: ScheduledTaskScope) => void;
  setSelectedRunId: (runId: string | null) => void;
  setEditor: (editor: ScheduledTaskEditor) => void;
  setSnapshot: (tasks: ScheduledTask[], runs: ScheduledTaskRun[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useScheduledTaskStore = create<ScheduledTaskState>((set) => ({
  tasks: [],
  runs: [],
  loading: false,
  initialized: false,
  error: null,
  scope: "current",
  selectedRunId: null,
  editor: null,
  showAllRuns: false,
  pendingRunTaskIds: [],
  listScrollPositions: {},
  expandedProjectPaths: [],
  setShowAllRuns: (showAllRuns) => set({ showAllRuns }),
  setListScrollPosition: (scopeKey, position) => set((state) => ({
    listScrollPositions: { ...state.listScrollPositions, [scopeKey]: position },
  })),
  toggleProjectExpanded: (projectPath) => set((state) => ({
    expandedProjectPaths: state.expandedProjectPaths.includes(projectPath)
      ? state.expandedProjectPaths.filter((path) => path !== projectPath)
      : [...state.expandedProjectPaths, projectPath],
  })),
  setScope: (scope) => set({ scope, selectedRunId: null }),
  setSelectedRunId: (selectedRunId) => set({ selectedRunId }),
  setEditor: (editor) => set({ editor }),
  setSnapshot: (tasks, runs) => set({ tasks, runs, initialized: true, error: null }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, initialized: true }),
}));

let refreshRequest: Promise<void> | null = null;

export async function startScheduledTaskRun(taskId: string): Promise<void> {
  const state = useScheduledTaskStore.getState();
  if (state.pendingRunTaskIds.includes(taskId)) return;
  useScheduledTaskStore.setState({ pendingRunTaskIds: [...state.pendingRunTaskIds, taskId] });
  try {
    const run = await runScheduledTaskNow(taskId);
    useScheduledTaskStore.setState((current) => ({
      runs: [run, ...current.runs.filter((item) => item.id !== run.id)],
      selectedRunId: run.id,
    }));
    await refreshScheduledTasks();
  } finally {
    useScheduledTaskStore.setState((current) => ({
      pendingRunTaskIds: current.pendingRunTaskIds.filter((id) => id !== taskId),
    }));
  }
}

export async function refreshScheduledTasks(): Promise<void> {
  if (refreshRequest) return refreshRequest;
  useScheduledTaskStore.getState().setLoading(true);
  refreshRequest = Promise.all([listScheduledTasks(), listScheduledTaskRuns({ limit: 50 })])
    .then(([tasks, runs]) => {
      useScheduledTaskStore.getState().setSnapshot(tasks, runs);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      useScheduledTaskStore.getState().setError(message);
      throw error;
    })
    .finally(() => {
      useScheduledTaskStore.getState().setLoading(false);
      refreshRequest = null;
    });
  return refreshRequest;
}

export function startScheduledTaskSync(): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void listen(SCHEDULED_TASKS_CHANGED_EVENT, () => {
    if (!disposed) {
      void refreshScheduledTasks().catch((error) => {
        console.error("Scheduled task refresh failed:", error);
      });
    }
  })
    .then((cleanup) => {
      if (disposed) cleanup(); else unlisten = cleanup;
    })
    .catch((error) => console.error("Scheduled task event listener failed:", error));
  void refreshScheduledTasks().catch((error) => {
    console.error("Scheduled task initial load failed:", error);
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}
