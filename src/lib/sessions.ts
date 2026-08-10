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
