import type { StateCreator } from "zustand";
import type { AppState, ProjectInfo } from "../types";
import type { WindowMode, WindowProjectContext } from "@/types";
import { createDefaultWorkspace, normalizeWorkspace, syncWorkspaceSnapshot } from "../utils/workspace";

export interface WindowSlice {
  windowContextReady: boolean;
  windowMode: WindowMode;
  windowLabel: string;
  windowProject: ProjectInfo | null;
  lastProject: ProjectInfo | null;
  sidebarCollapsed: boolean;
  initializeWindowContext: (context: WindowProjectContext) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
}

export const createWindowSlice: StateCreator<AppState, [], [], WindowSlice> = (set) => ({
  windowContextReady: false,
  windowMode: "launcher",
  windowLabel: "main",
  windowProject: null,
  lastProject: null,
  sidebarCollapsed: false,
  initializeWindowContext: (context) =>
    set((state) => {
      const windowProject =
        context.mode === "project" && context.projectPath
          ? {
              path: context.projectPath,
              name:
                context.projectName ||
                context.projectPath.split(/[\\/]/).pop() ||
                context.projectPath,
            }
          : null;

      if (!windowProject) {
        return {
          windowContextReady: true,
          windowMode: context.mode,
          windowLabel: context.windowLabel,
          windowProject: null,
          currentProject: null,
          sessions: [],
          tabsById: {},
          panesById: createDefaultWorkspace().panesById,
          layout: { root: { type: "pane", paneId: "main" } },
          activePaneId: "main",
          focusedTabId: null,
          openTabs: [],
          activeSessionId: null,
          unreadTotal: 0,
        };
      }

      const sessions = state.projectSessions[windowProject.path] || [];
      const workspace =
        state.projectWorkspaces[windowProject.path] || createDefaultWorkspace();
      const normalizedWorkspace = normalizeWorkspace(workspace, sessions);

      return {
        windowContextReady: true,
        windowMode: context.mode,
        windowLabel: context.windowLabel,
        windowProject,
        lastProject: windowProject,
        currentProject: windowProject,
        sessions,
        projectWorkspaces: {
          ...state.projectWorkspaces,
          [windowProject.path]: normalizedWorkspace,
        },
        unreadTotal: sessions.reduce(
          (acc, session) => acc + (session.unreadCount ?? 0),
          0
        ),
        ...syncWorkspaceSnapshot(normalizedWorkspace),
      };
    }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  toggleSidebar: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
});
