import type { Session } from "@/types";

export type AgentUserResponseEventType = "permission_request" | "waiting_input";

export interface AgentUserResponseBaseline {
  revision: number;
  eventType: AgentUserResponseEventType;
}

export function getAgentUserResponseBaseline(
  session: Session | undefined,
): AgentUserResponseBaseline | null {
  if (
    session?.status !== "waiting" ||
    session.statusRevision === undefined ||
    (session.lastEventType !== "permission_request" && session.lastEventType !== "waiting_input")
  ) {
    return null;
  }
  return {
    revision: session.statusRevision,
    eventType: session.lastEventType,
  };
}

export function isAgentUserResponseBaselineCurrent(
  session: Session | undefined,
  baseline: AgentUserResponseBaseline,
): boolean {
  return (
    session?.status === "waiting" &&
    session.statusRevision === baseline.revision &&
    session.lastEventType === baseline.eventType
  );
}
