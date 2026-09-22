import { create } from "zustand";
import { emit, listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store";
import { collectTaskMonitorTabs, type TaskMonitorSnapshot } from "@/lib/taskMonitor";
import { closeTabRuntime } from "@/lib/tabClose";
import { requestWorkspaceClose } from "./background";

const SNAPSHOT_EVENT = "termflow-task-monitor-snapshot";
const REQUEST_EVENT = "termflow-task-monitor-request";
const CLOSE_REQUEST_EVENT = "termflow-task-monitor-close-request";
const PROJECT_CLOSE_REQUEST_EVENT = "termflow-task-monitor-project-close-request";

export interface TaskMonitorCloseRequest {
  windowLabel: string;
  tabId: string;
}

interface TaskMonitorState {
  snapshots: Record<string, TaskMonitorSnapshot>;
  setSnapshot: (snapshot: TaskMonitorSnapshot) => void;
}

export const useTaskMonitorStore = create<TaskMonitorState>((set) => ({
  snapshots: {},
  setSnapshot: (snapshot) => set((state) => ({
    snapshots: { ...state.snapshots, [snapshot.windowLabel]: snapshot },
  })),
}));

export async function requestTaskMonitorSnapshots() {
  await emit(REQUEST_EVENT);
}

export async function requestTaskMonitorTabClose(request: TaskMonitorCloseRequest) {
  await emit(CLOSE_REQUEST_EVENT, request);
}

export async function requestTaskMonitorProjectClose(windowLabel: string, projectPath: string) {
  await emit(PROJECT_CLOSE_REQUEST_EVENT, { windowLabel, projectPath });
}

// 每个项目窗口常驻响应快照请求，状态只传标签元数据，不传终端内容。
export function startTaskMonitorSync(onProjectCloseError?: (error: unknown) => void): () => void {
  let disposed = false;
  const cleanups: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closeTab = async (request: TaskMonitorCloseRequest) => {
    const state = useAppStore.getState();
    if (disposed || request.windowLabel !== state.windowLabel) return;
    const tab = state.tabsById[request.tabId];
    if (!tab) return;
    try {
      await closeTabRuntime(tab);
      useAppStore.getState().closeTab(request.tabId);
    } catch (error) {
      console.error("Task monitor tab close failed:", error);
    }
  };
  const publish = () => {
    const state = useAppStore.getState();
    const snapshot: TaskMonitorSnapshot = {
      windowLabel: state.windowLabel,
      projectPath: state.currentProject?.path ?? "",
      tabs: collectTaskMonitorTabs(state.sessions, state.panesById, state.tabsById),
    };
    useTaskMonitorStore.getState().setSnapshot(snapshot);
    void emit(SNAPSHOT_EVENT, snapshot).catch((error) => console.error("Task monitor sync failed:", error));
  };
  const register = async () => {
    const results = await Promise.allSettled([
      listen<TaskMonitorSnapshot>(SNAPSHOT_EVENT, ({ payload }) => {
        if (!disposed) useTaskMonitorStore.getState().setSnapshot(payload);
      }),
      listen(REQUEST_EVENT, () => { if (!disposed) publish(); }),
      listen<TaskMonitorCloseRequest>(CLOSE_REQUEST_EVENT, ({ payload }) => { void closeTab(payload); }),
      listen<{ windowLabel: string; projectPath: string }>(PROJECT_CLOSE_REQUEST_EVENT, ({ payload }) => {
        const state = useAppStore.getState();
        if (disposed || payload.windowLabel !== state.windowLabel || payload.projectPath !== state.currentProject?.path) return;
        void requestWorkspaceClose(false, true).catch((error) => {
          console.error("Task monitor project close failed:", error);
          onProjectCloseError?.(error);
        });
      }),
    ]);
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (disposed) result.value(); else cleanups.push(result.value);
      } else { console.error("Task monitor listener failed:", result.reason); }
    }
    if (!disposed) publish();
  };
  void register();
  cleanups.push(useAppStore.subscribe((state, previous) => {
    if (state.sessions === previous.sessions && state.panesById === previous.panesById &&
      state.tabsById === previous.tabsById && state.currentProject === previous.currentProject) return;
    clearTimeout(timer);
    timer = setTimeout(publish, 80);
  }));
  return () => { disposed = true; clearTimeout(timer); cleanups.forEach((cleanup) => cleanup()); };
}
