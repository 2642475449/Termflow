import { useAppStore } from "@/store";
import { generateSessionTitle, readCodexSessionTitles } from "@/lib/api";
import { startCodexTitleSync } from "@/lib/codexSessionTitles";
import { queueSessionTitle, startTitleGeneration } from "@/lib/sessionTitles";
import type { Session } from "@/types";
import { syncWorkspaceSnapshot } from "../utils/workspace";

function setSessionTitleState(id: string, change: (session: Session) => Session) {
  useAppStore.setState((state) => {
    const projectSessions = { ...state.projectSessions };
    const projectWorkspaces = { ...state.projectWorkspaces };
    let changed = false;
    for (const [path, sessions] of Object.entries(projectSessions)) {
      const current = sessions.find((session) => session.id === id);
      if (!current) continue;
      const next = change(current);
      if (next === current) continue;
      projectSessions[path] = sessions.map((session) => session.id === id ? next : session);
      const name = next.name;
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
  const shared = {
    sessions: () => Object.values(useAppStore.getState().projectSessions).flat(),
    update: setSessionTitleState,
    subscribe: (listener: () => void) => useAppStore.subscribe(listener),
  };
  const stopNative = startCodexTitleSync({ ...shared, read: readCodexSessionTitles });
  const stopGeneration = startTitleGeneration({ ...shared, generate: generateSessionTitle });
  return () => { stopNative(); stopGeneration(); };
}
