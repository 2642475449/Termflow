import { useAppStore } from "@/store";
import { generateSessionTitle } from "@/lib/api";
import { queueSessionTitle, startTitleGeneration } from "@/lib/sessionTitles";
import type { Session } from "@/types";
import { syncWorkspaceSnapshot } from "../utils/workspace";

function setSessionTitleState(id: string, change: (session: Session) => Session) {
  useAppStore.setState((state) => {
    const projectSessions = { ...state.projectSessions };
    const projectWorkspaces = { ...state.projectWorkspaces };
    let changed = false;
    for (const [path, sessions] of Object.entries(projectSessions)) {
      if (!sessions.some((session) => session.id === id)) continue;
      projectSessions[path] = sessions.map((session) => session.id === id ? change(session) : session);
      const name = projectSessions[path].find((session) => session.id === id)!.name;
      const workspace = projectWorkspaces[path];
      if (workspace) projectWorkspaces[path] = {
        ...workspace,
        tabsById: Object.fromEntries(Object.entries(workspace.tabsById).map(([tabId, tab]) => [
          tabId, tab.kind === "session" && tab.resourceId === id ? { ...tab, title: name } : tab,
        ])),
      };
      changed = true;
    }
    if (!changed) return state;
    return {
      projectSessions, projectWorkspaces,
      sessions: state.currentProject ? projectSessions[state.currentProject.path] ?? state.sessions : state.sessions,
      ...(state.currentProject && projectWorkspaces[state.currentProject.path]
        ? syncWorkspaceSnapshot(projectWorkspaces[state.currentProject.path]) : {}),
    };
  });
}

export function setSessionTitlePrompt(id: string, prompt: string) {
  setSessionTitleState(id, (session) => queueSessionTitle(session, prompt));
}

export function retrySessionTitle(id: string) {
  setSessionTitleState(id, (session) => queueSessionTitle(session,
    session.titleGeneration?.prompt || session.temporaryTitle || session.firstPromptTitle || "", true));
}

export function startSessionTitleGeneration() {
  return startTitleGeneration({
    sessions: () => Object.values(useAppStore.getState().projectSessions).flat(),
    update: setSessionTitleState,
    generate: generateSessionTitle,
    subscribe: (listener) => useAppStore.subscribe(listener),
  });
}
