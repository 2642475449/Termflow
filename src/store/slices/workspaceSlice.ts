import type { StateCreator } from "zustand";
import type { AppState, DragState, PaneState, ProjectWorkspace, SplitDirection, SplitMode, TabDropPosition, TabEntity, WorkspaceLayout } from "../types";
import { createDefaultWorkspace, syncWorkspaceSnapshot, openTabInWorkspace, activateTabInWorkspace, closeTabInWorkspace, reorderTabsInWorkspace, moveTabToPaneInWorkspace, splitTabInWorkspace } from "../utils/workspace";

export interface WorkspaceSlice {
  projectWorkspaces: Record<string, ProjectWorkspace>;
  tabsById: Record<string, TabEntity>;
  panesById: Record<string, PaneState>;
  layout: WorkspaceLayout;
  activePaneId: string | null;
  focusedTabId: string | null;
  dragState: DragState | null;
  activeSessionId: string | null;
  openTabs: string[];
  setActiveSession: (id: string | null, paneId?: string) => void;
  openTab: (tabId: string) => void;
  closeTab: (tabId: string, paneId?: string) => void;
  reorderTabs: (
    sourceTabId: string,
    targetTabId: string,
    position: TabDropPosition,
    paneId?: string
  ) => void;
  moveTab: (
    tabId: string,
    sourcePaneId: string,
    targetPaneId: string,
    targetTabId?: string | null,
    position?: TabDropPosition
  ) => void;
  splitTab: (tabId: string, direction: SplitDirection, paneId?: string, mode?: SplitMode) => void;
  setDragState: (dragState: DragState | null) => void;
}

export const createWorkspaceSlice: StateCreator<AppState, [], [], WorkspaceSlice> = (set) => ({
  projectWorkspaces: {},
  tabsById: {},
  panesById: createDefaultWorkspace().panesById,
  layout: { root: { type: "pane", paneId: "main" } },
  activePaneId: "main",
  focusedTabId: null,
  dragState: null,
  activeSessionId: null,
  openTabs: [],
  setActiveSession: (id, paneId) =>
    set((state) => {
      if (!state.currentProject) {
        return { activeSessionId: id };
      }
      const path = state.currentProject.path;
      const sessions = id
        ? state.sessions.map((session) =>
            session.id === id ? { ...session, unreadCount: 0 } : session
          )
        : state.sessions;
      const sessionEvents = id
        ? state.sessionEvents.map((event) =>
            event.sessionId === id ? { ...event, read: true } : event
          )
        : state.sessionEvents;
      const unreadTotal = sessions.reduce((acc, session) => acc + (session.unreadCount ?? 0), 0);
      const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
      const nextWorkspace = activateTabInWorkspace(currentWorkspace, id, paneId);
      return {
        projectSessions: { ...state.projectSessions, [path]: sessions },
        projectWorkspaces: {
          ...state.projectWorkspaces,
          [path]: nextWorkspace,
        },
        sessions,
        ...syncWorkspaceSnapshot(nextWorkspace),
        sessionEvents,
        unreadTotal,
      };
    }),
  openTab: (tabId) =>
    set((state) => {
      if (!state.currentProject) return state;
      const path = state.currentProject.path;
      const sessions = state.sessions.map((session) =>
        session.id === tabId ? { ...session, unreadCount: 0 } : session
      );
      const sessionEvents = state.sessionEvents.map((event) =>
        event.sessionId === tabId ? { ...event, read: true } : event
      );
      const unreadTotal = sessions.reduce((acc, session) => acc + (session.unreadCount ?? 0), 0);
      const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
      const nextWorkspace = openTabInWorkspace(currentWorkspace, tabId, sessions);
      return {
        projectSessions: { ...state.projectSessions, [path]: sessions },
        projectWorkspaces: {
          ...state.projectWorkspaces,
          [path]: nextWorkspace,
        },
        sessions,
        ...syncWorkspaceSnapshot(nextWorkspace),
        sessionEvents,
        unreadTotal,
      };
    }),
  closeTab: (tabId, paneId) =>
    set((state) => {
      if (!state.currentProject) return state;
      const path = state.currentProject.path;
      const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
      const nextWorkspace = closeTabInWorkspace(currentWorkspace, tabId, paneId);
      return {
        projectWorkspaces: {
          ...state.projectWorkspaces,
          [path]: nextWorkspace,
        },
        ...syncWorkspaceSnapshot(nextWorkspace),
      };
    }),
  reorderTabs: (sourceTabId, targetTabId, position, paneId) =>
    set((state) => {
      if (!state.currentProject) return state;
      const path = state.currentProject.path;
      const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
      const nextWorkspace = reorderTabsInWorkspace(
        currentWorkspace,
        sourceTabId,
        targetTabId,
        position,
        paneId
      );
      return {
        projectWorkspaces: {
          ...state.projectWorkspaces,
          [path]: nextWorkspace,
        },
        ...syncWorkspaceSnapshot(nextWorkspace),
      };
    }),
  moveTab: (tabId, sourcePaneId, targetPaneId, targetTabId, position) =>
    set((state) => {
      if (!state.currentProject) return state;
      const path = state.currentProject.path;
      const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
      const nextWorkspace = moveTabToPaneInWorkspace(
        currentWorkspace,
        tabId,
        sourcePaneId,
        targetPaneId,
        targetTabId,
        position
      );
      return {
        projectWorkspaces: { ...state.projectWorkspaces, [path]: nextWorkspace },
        ...syncWorkspaceSnapshot(nextWorkspace),
      };
    }),
  splitTab: (tabId, direction, paneId, mode) =>
    set((state) => {
      if (!state.currentProject) return state;
      const path = state.currentProject.path;
      const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
      const nextWorkspace = splitTabInWorkspace(currentWorkspace, tabId, direction, paneId, mode);
      return {
        projectWorkspaces: { ...state.projectWorkspaces, [path]: nextWorkspace },
        ...syncWorkspaceSnapshot(nextWorkspace),
      };
    }),
  setDragState: (dragState) => set({ dragState }),
});
