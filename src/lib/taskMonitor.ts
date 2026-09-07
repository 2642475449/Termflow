import type { Session } from "@/types";
import { isAiAgentId } from "@/lib/agents";

export interface TaskMonitorTab {
  id: string;
  paneId: string;
  name: string;
  agentId: NonNullable<Session["agentId"]>;
  status: NonNullable<Session["status"]> | "idle";
}

export interface TaskMonitorSnapshot {
  windowLabel: string;
  projectPath: string;
  tabs: TaskMonitorTab[];
}

export function collectTaskMonitorTabs(
  sessions: Session[],
  panes: Record<string, { id: string; tabIds: string[] }>,
  tabs: Record<string, { title: string }>,
): TaskMonitorTab[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const seen = new Set<string>();
  const result: TaskMonitorTab[] = [];
  for (const pane of Object.values(panes)) {
    for (const id of pane.tabIds) {
      const session = byId.get(id);
      if (!session || session.archived || !session.agentId || !isAiAgentId(session.agentId) || seen.has(id)) continue;
      seen.add(id);
      result.push({
        id, paneId: pane.id, name: tabs[id]?.title || session.name,
        agentId: session.agentId,
        status: session.status === "error" || session.status === "completed"
          ? session.status : session.active ? session.status ?? "idle" : "idle",
      });
    }
  }
  return result;
}
