import type { Session } from "@/types";
import type { AttentionSourceEvent } from "./attention";

type CompletionEvent = Pick<
  AttentionSourceEvent,
  "sessionId" | "source" | "eventType" | "revision" | "createdAt"
>;

/** 完成通知与 agent-status 可能分开送达，用同一版本的完成事实补齐运行状态。 */
export function getAgentCompletionUpdates(
  session: Session | undefined,
  event: CompletionEvent,
): Partial<Session> | null {
  if (
    !session ||
    session.id !== event.sessionId ||
    session.agentId !== event.source ||
    !session.active ||
    session.archived ||
    !["starting", "running", "waiting"].includes(session.status ?? "") ||
    event.eventType !== "assistant_complete" ||
    typeof event.revision !== "number" ||
    !Number.isSafeInteger(event.revision) ||
    event.revision <= (session.statusRevision ?? 0) ||
    !Number.isFinite(event.createdAt) ||
    event.createdAt < Math.max(session.statusUpdatedAt ?? 0, session.lastEventAt ?? 0)
  ) {
    return null;
  }

  return {
    status: "completed",
    statusRevision: event.revision,
    statusUpdatedAt: event.createdAt,
  };
}
