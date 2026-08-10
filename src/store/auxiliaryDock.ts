import { create } from "zustand";

export type AuxiliaryTabKind = "terminal" | "task" | "file" | "review";

export interface AuxiliaryTab {
  id: string;
  kind: AuxiliaryTabKind;
  title: string;
  projectPath: string;
  resourceId: string;
  preview: boolean;
  createdAt: number;
}

interface AuxiliaryDockState {
  open: boolean;
  width: number;
  tabs: AuxiliaryTab[];
  activeTabId: string | null;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setWidth: (width: number) => void;
  activateTab: (tabId: string) => void;
  openSession: (input: {
    sessionId: string;
    projectPath: string;
    title: string;
    kind: "terminal" | "task";
  }) => void;
  openFile: (input: {
    path: string;
    projectPath: string;
    title?: string;
    preview?: boolean;
  }) => void;
  openReview: (input: { sessionId: string; projectPath: string; title: string }) => void;
  pinTab: (tabId: string) => void;
  closeTab: (tabId: string, preferredTabId?: string) => void;
  reset: () => void;
}

export const DEFAULT_AUXILIARY_DOCK_WIDTH = 480;
export const MIN_AUXILIARY_DOCK_WIDTH = 360;
export const MAX_AUXILIARY_DOCK_WIDTH = 880;

export function clampAuxiliaryDockWidth(width: number) {
  if (!Number.isFinite(width)) return DEFAULT_AUXILIARY_DOCK_WIDTH;
  return Math.min(MAX_AUXILIARY_DOCK_WIDTH, Math.max(MIN_AUXILIARY_DOCK_WIDTH, width));
}

function fileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export const useAuxiliaryDockStore = create<AuxiliaryDockState>((set) => ({
  open: false,
  width: DEFAULT_AUXILIARY_DOCK_WIDTH,
  tabs: [],
  activeTabId: null,
  setOpen: (open) => set({ open }),
  toggle: () => set((state) => ({ open: !state.open })),
  setWidth: (width) => set({ width: clampAuxiliaryDockWidth(width) }),
  activateTab: (activeTabId) => set({ activeTabId, open: true }),
  openSession: ({ sessionId, projectPath, title, kind }) =>
    set((state) => {
      const id = `aux:${kind}:${sessionId}`;
      const existing = state.tabs.find((tab) => tab.id === id);
      const tab: AuxiliaryTab = existing ?? {
        id,
        kind,
        title,
        projectPath,
        resourceId: sessionId,
        preview: false,
        createdAt: Date.now(),
      };
      return {
        open: true,
        activeTabId: id,
        tabs: existing
          ? state.tabs.map((item) => (item.id === id ? { ...item, title } : item))
          : [...state.tabs, tab],
      };
    }),
  openFile: ({ path, projectPath, title, preview = true }) =>
    set((state) => {
      const id = `aux:file:${projectPath}:${path}`;
      const existing = state.tabs.find((tab) => tab.id === id);
      let tabs = state.tabs;
      if (!existing && preview) {
        tabs = tabs.filter((tab) => !(tab.kind === "file" && tab.preview));
      }
      const tab: AuxiliaryTab = existing ?? {
        id,
        kind: "file",
        title: title ?? fileName(path),
        projectPath,
        resourceId: path,
        preview,
        createdAt: Date.now(),
      };
      return {
        open: true,
        activeTabId: id,
        tabs: existing ? tabs : [...tabs, tab],
      };
    }),
  openReview: ({ sessionId, projectPath, title }) =>
    set((state) => {
      const id = `aux:review:${sessionId}`;
      const existing = state.tabs.find((tab) => tab.id === id);
      const tab: AuxiliaryTab = existing ?? {
        id,
        kind: "review",
        title,
        projectPath,
        resourceId: sessionId,
        preview: false,
        createdAt: Date.now(),
      };
      return {
        open: true,
        activeTabId: id,
        tabs: existing
          ? state.tabs.map((item) => (item.id === id ? { ...item, title } : item))
          : [...state.tabs, tab],
      };
    }),
  pinTab: (tabId) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, preview: false } : tab)),
    })),
  closeTab: (tabId, preferredTabId) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== tabId);
      const fallback = tabs.find((tab) => tab.id === preferredTabId)
        ?? tabs[Math.min(index, tabs.length - 1)]
        ?? null;
      return {
        tabs,
        activeTabId: state.activeTabId === tabId ? fallback?.id ?? null : state.activeTabId,
        open: tabs.length > 0 ? state.open : false,
      };
    }),
  reset: () => set({ open: false, tabs: [], activeTabId: null }),
}));

export function isSessionVisibleInAuxiliaryDock(sessionId: string) {
  const state = useAuxiliaryDockStore.getState();
  if (!state.open || !state.activeTabId) return false;
  const tab = state.tabs.find((item) => item.id === state.activeTabId);
  return Boolean(
    tab &&
      (tab.kind === "terminal" || tab.kind === "task") &&
      tab.resourceId === sessionId,
  );
}
