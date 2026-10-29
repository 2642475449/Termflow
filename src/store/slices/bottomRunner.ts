import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { BottomRunnerState, BottomRunnerTab, BottomRunnerTabStatus } from "../types";
export type { BottomRunnerState, BottomRunnerTab, BottomRunnerTabStatus } from "../types";

export const DEFAULT_BOTTOM_RUNNER_HEIGHT = 260;
export const MIN_BOTTOM_RUNNER_HEIGHT = 120;
export const MAX_BOTTOM_RUNNER_HEIGHT = 650;
export const AUTO_COLLAPSE_VIEWPORT_HEIGHT_THRESHOLD = 350;
export const MAX_BOTTOM_RUNNER_TABS = 8;
export const EMPTY_RUNNER_TABS: BottomRunnerTab[] = [];

export function clampBottomRunnerHeight(height: number, viewportHeight = typeof window === "undefined" ? 800 : window.innerHeight) {
  if (viewportHeight < AUTO_COLLAPSE_VIEWPORT_HEIGHT_THRESHOLD) return 0;
  const max = Math.min(MAX_BOTTOM_RUNNER_HEIGHT, Math.max(MIN_BOTTOM_RUNNER_HEIGHT, viewportHeight - 220));
  return Math.min(max, Math.max(MIN_BOTTOM_RUNNER_HEIGHT, Math.round(Number.isFinite(height) ? height : DEFAULT_BOTTOM_RUNNER_HEIGHT)));
}

export function isRunnerRunning(tab: Pick<BottomRunnerTab, "status">) {
  return tab.status === "starting" || tab.status === "running";
}

export function runnerExitStatus(code: number | null): BottomRunnerTabStatus {
  return code === null ? "completed" : code === 0 ? "success" : "error";
}

export const useBottomRunnerStore = create<BottomRunnerState>()(persist((set, get) => ({
  open: false,
  height: DEFAULT_BOTTOM_RUNNER_HEIGHT,
  maximized: false,
  autoScroll: true,
  wordWrap: false,
  tabsByProject: {},
  activeTabIdByProject: {},
  setOpen: (open) => set({ open: open && clampBottomRunnerHeight(get().height) > 0 }),
  toggleOpen: () => get().setOpen(!get().open),
  setHeight: (height, viewportHeight) => {
    const next = clampBottomRunnerHeight(height, viewportHeight);
    // 小视口折叠时仍保留用户偏好的高度。
    set(next === 0 ? { open: false, maximized: false } : { height: next });
  },
  setMaximized: (maximized) => set({ maximized }),
  toggleMaximized: () => set((state) => ({ maximized: !state.maximized })),
  setAutoScroll: (autoScroll) => set({ autoScroll }),
  toggleAutoScroll: () => set((state) => ({ autoScroll: !state.autoScroll })),
  setWordWrap: (wordWrap) => set({ wordWrap }),
  toggleWordWrap: () => set((state) => ({ wordWrap: !state.wordWrap })),
  activateTab: (projectPath, tabId) => {
    if (!get().tabsByProject[projectPath]?.some((tab) => tab.id === tabId)) return;
    set((state) => ({ activeTabIdByProject: { ...state.activeTabIdByProject, [projectPath]: tabId } }));
    get().setOpen(true);
  },
  addRunTab: (projectPath, tab) => {
    const current = get().tabsByProject[projectPath] ?? [];
    const existing = current.find((item) => item.id === tab.id);
    const evicted = !existing && current.length >= MAX_BOTTOM_RUNNER_TABS
      ? current.find((item) => !isRunnerRunning(item)) ?? current[0] : null;
    const tabs = existing ? current.map((item) => item.id === tab.id ? tab : item)
      : [...current.filter((item) => item !== evicted), tab];
    set((state) => ({
      tabsByProject: { ...state.tabsByProject, [projectPath]: tabs },
      activeTabIdByProject: { ...state.activeTabIdByProject, [projectPath]: tab.id },
    }));
    get().setOpen(true);
    // 调用者必须清理被回收的 PTY 和 AppStore 会话。
    return evicted;
  },
  updateTabStatus: (projectPath, tabId, status, exitCode) => set((state) => ({
    tabsByProject: { ...state.tabsByProject, [projectPath]: (state.tabsByProject[projectPath] ?? []).map((tab) => tab.id === tabId ? {
      ...tab, status, exitCode: exitCode === undefined ? tab.exitCode : exitCode,
      endTime: isRunnerRunning({ status }) ? null : tab.endTime ?? Date.now(),
    } : tab) },
  })),
  closeTab: (projectPath, tabId) => set((state) => {
    const current = state.tabsByProject[projectPath] ?? [];
    const index = current.findIndex((tab) => tab.id === tabId);
    if (index < 0) return state;
    const tabs = current.filter((tab) => tab.id !== tabId);
    return {
      tabsByProject: { ...state.tabsByProject, [projectPath]: tabs },
      activeTabIdByProject: { ...state.activeTabIdByProject, [projectPath]: state.activeTabIdByProject[projectPath] === tabId
        ? tabs[Math.min(index, tabs.length - 1)]?.id ?? null : state.activeTabIdByProject[projectPath] },
      open: tabs.length ? state.open : false,
    };
  }),
  clearFinishedTabs: (projectPath) => {
    for (const tab of get().tabsByProject[projectPath] ?? []) {
      if (!isRunnerRunning(tab)) get().closeTab(projectPath, tab.id);
    }
  },
  handleProjectChange: (projectPath) => {
    if (!get().tabsByProject[projectPath]?.length) set({ open: false });
  },
  reset: () => set({ open: false, maximized: false, tabsByProject: {}, activeTabIdByProject: {} }),
}), {
  name: "termflow-bottom-runner-storage",
  storage: createJSONStorage(() => typeof localStorage !== "undefined" ? localStorage : {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
  }),
  partialize: (state) => ({ height: state.height, autoScroll: state.autoScroll, wordWrap: state.wordWrap }),
  merge: (saved, current) => {
    const prefs = (saved && typeof saved === "object" ? saved : {}) as Partial<BottomRunnerState>;
    return { ...current,
      height: clampBottomRunnerHeight(typeof prefs.height === "number" ? prefs.height : DEFAULT_BOTTOM_RUNNER_HEIGHT, 1000),
      autoScroll: typeof prefs.autoScroll === "boolean" ? prefs.autoScroll : true,
      wordWrap: typeof prefs.wordWrap === "boolean" ? prefs.wordWrap : false,
    };
  },
}));
