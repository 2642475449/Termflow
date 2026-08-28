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

/**
 * 检查点输入分流只能把仍有活动回合的等待状态视为“回复 Agent”。
 * Provider 在普通提示符上也可能保留 waiting_input；此时没有活动检查点，
 * 下一次提交必须作为新回合建立 baseline。
 */
export function getCheckpointedAgentUserResponseBaseline(
  session: Session | undefined,
): AgentUserResponseBaseline | null {
  if (!session?.checkpointActiveTurnId) return null;
  return getAgentUserResponseBaseline(session);
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
