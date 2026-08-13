import type { Session } from "@/types";

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
    ...session,
    active: false,
    status,
  };
}

/** Auxiliary tasks live in the Dock and must not be duplicated in session history. */
export function isSessionVisibleInHistory(session: Session): boolean {
  return !isEphemeralTerminalSession(session) && session.presentation !== "auxiliary";
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
