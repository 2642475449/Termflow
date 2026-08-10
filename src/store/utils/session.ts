import type { Session } from "@/types";
import type { SessionEventType, SessionRuntimeStatus } from "../types";

export function updateSessionCollection(
  sessions: Session[],
  sessionId: string,
  updates: Partial<Session>
) {
  return sessions.map((session) =>
    session.id === sessionId ? { ...session, ...updates } : session
  );
}

export function mapStatusFromEvent(eventType: SessionEventType): SessionRuntimeStatus {
  if (eventType === "session_started" || eventType === "session_resumed") return "waiting";
  if (eventType === "assistant_complete") return "completed";
  if (eventType === "waiting_input" || eventType === "permission_request") return "waiting";
  if (eventType === "process_error" || eventType === "hook_error") return "error";
  if (eventType === "process_exit") return "stopped";
  return "running";
}
