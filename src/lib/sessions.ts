import type { Session, TerminalSplitTarget } from "@/types";
import type { AppState } from "@/store/types";
import { normalizeSessionTitles } from "./sessionTitles";

/** 单标签分屏创建独立会话，保留源标签；复用现有 store action 处理布局。 */
export function addTerminalSession(
  state: Pick<AppState, "currentProject" | "panesById" | "setActiveSession" | "addSession" | "splitTab">,
  session: Session,
  split?: TerminalSplitTarget,
): boolean {
  if (state.currentProject?.path !== session.path) return false;
  if (split) {
    if (!state.panesById[split.paneId]?.tabIds.includes(split.tabId)) return false;
    state.setActiveSession(split.tabId, split.paneId);
  }
  state.addSession(session, { openInWorkspace: session.presentation !== "auxiliary" });
  if (split) state.splitTab(session.id, split.direction, split.paneId, "move");
  return true;
}

/**
 * Terminal tabs have no resumable agent conversation behind them. The legacy
 * quick-command check also handles terminal commands saved before `ephemeral`
 * and terminal `agentId` were introduced.
 */
export function isEphemeralTerminalSession(session: Session): boolean {
  return (
    session.ephemeral === true ||
    session.agentId === "powershell" ||
    session.agentId === "cmd" ||
    (session.id.startsWith("qc-") && !session.hasPromptHistory)
  );
}

/**
 * A live PTY (`active`) can be idle at its prompt. Only these runtime states
 * mean the agent is currently starting or executing a turn.
 */
export function isSessionTurnRunning(session: Session): boolean {
  return session.active && (session.status === "starting" || session.status === "running");
}

/**
 * PTY availability and in-flight turn states belong to the current desktop
 * process. Persist only a resumable, inactive history snapshot.
 */
export function toPersistedSession(session: Session): Session {
  const status = session.status === "starting" || session.status === "running"
    ? "stopped"
    : session.status;

  return {
    ...normalizeSessionTitles(session),
    active: false,
    status,
  };
}

/** Auxiliary tasks live in the Dock and must not be duplicated in session history. */
export function isSessionVisibleInHistory(session: Session): boolean {
  return !isEphemeralTerminalSession(session) && session.presentation !== "auxiliary" && session.presentation !== "bottom-runner";
}

export function withoutEphemeralTerminalSessions(
  projectSessions: Record<string, Session[]>,
): Record<string, Session[]> {
  return Object.fromEntries(
    Object.entries(projectSessions).map(([path, sessions]) => [
      path,
      sessions.filter((session) => !isEphemeralTerminalSession(session)),
    ]),
  );
}

/** Removes sessions that belong to transient UI surfaces from persisted history. */
export function withoutSessionHistoryExcludedSessions(
  projectSessions: Record<string, Session[]>,
): Record<string, Session[]> {
  return Object.fromEntries(
    Object.entries(projectSessions).map(([path, sessions]) => [
      path,
      sessions.filter(isSessionVisibleInHistory),
    ]),
  );
}

/** Removes transient sessions and strips process-local runtime state. */
export function toPersistedProjectSessions(
  projectSessions: Record<string, Session[]>,
): Record<string, Session[]> {
  return Object.fromEntries(
    Object.entries(projectSessions).map(([path, sessions]) => [
      path,
      sessions.filter(isSessionVisibleInHistory).map(toPersistedSession),
    ]),
  );
}
