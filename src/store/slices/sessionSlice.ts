import type { StateCreator } from "zustand";
import type { AppState, ProjectInfo } from "../types";
import type { Session } from "@/types";
import { createDefaultWorkspace, normalizeWorkspace, syncWorkspaceSnapshot, openTabInWorkspace, closeTabInWorkspace } from "../utils/workspace";
import { updateSessionCollection } from "../utils/session";

export interface SessionSlice {
  currentProject: ProjectInfo | null;
  projectSessions: Record<string, Session[]>;
  sessions: Session[];
  setCurrentProject: (project: ProjectInfo) => void;
  addSession: (session: Session) => void;
  updateSession: (sessionId: string, updates: Partial<Session>) => void;
  removeSession: (sessionId: string) => void;
  removeAllSessions: () => void;
}

function syncProjectState(
  state: AppState,
  path: string,
  sessions: Session[],
  workspace: ReturnType<typeof createDefaultWorkspace>
) {
  const normalizedWorkspace = normalizeWorkspace(workspace, sessions);
  return {
    projectSessions: { ...state.projectSessions, [path]: sessions },
    projectWorkspaces: {
      ...state.projectWorkspaces,
      [path]: normalizedWorkspace,
    },
    sessions,
    ...syncWorkspaceSnapshot(normalizedWorkspace),
  };
}

export const createSessionSlice: StateCreator<AppState, [], [], SessionSlice> = (set) => ({
  currentProject: null,
  projectSessions: {},
  sessions: [],
  setCurrentProject: (project) =>
    set((state) => {
      const sessions = state.projectSessions[project.path] || [];
      const workspace = state.projectWorkspaces[project.path] || createDefaultWorkspace();
      const normalizedWorkspace = normalizeWorkspace(workspace, sessions);
      return {
        currentProject: project,
        lastProject: project,
        sessions,
        projectWorkspaces: {
          ...state.projectWorkspaces,
          [project.path]: normalizedWorkspace,
        },
        unreadTotal: sessions.reduce((acc, session) => acc + (session.unreadCount ?? 0), 0),
        ...syncWorkspaceSnapshot(normalizedWorkspace),
      };
    }),
  addSession: (session) =>
    set((state) => {
      if (!state.currentProject) return state;
      const path = state.currentProject.path;
      const existingSessions = state.projectSessions[path] || [];
      const normalizedSession = {
        ...session,
        titleSource: session.titleSource ?? "default",
        status: session.status ?? "waiting",
        unreadCount: session.unreadCount ?? 0,
      };
      const sessions = [normalizedSession, ...existingSessions];
      const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
      const nextWorkspace = openTabInWorkspace(currentWorkspace, normalizedSession.id, sessions);
      return syncProjectState(state, path, sessions, nextWorkspace);
    }),
  updateSession: (sessionId, updates) =>
    set((state) => {
      if (!state.currentProject) return state;
      const path = state.currentProject.path;
      const sessions = updateSessionCollection(
        state.projectSessions[path] || [],
        sessionId,
        updates
      );
      const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
      return syncProjectState(state, path, sessions, currentWorkspace);
    }),
  removeSession: (sessionId) =>
    set((state) => {
      if (!state.currentProject) return state;
      const path = state.currentProject.path;
      const sessions = (state.projectSessions[path] || []).filter(
        (session) => session.id !== sessionId
      );
      const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
      const nextWorkspace = closeTabInWorkspace(currentWorkspace, sessionId);
      return syncProjectState(state, path, sessions, nextWorkspace);
    }),
  removeAllSessions: () =>
    set((state) => {
      if (!state.currentProject) return state;
      const path = state.currentProject.path;
      const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
      const nextWorkspace = normalizeWorkspace(currentWorkspace, []);
      return syncProjectState(state, path, [], nextWorkspace);
    }),
});
