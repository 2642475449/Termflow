import type { Session, WindowProjectContext } from "@/types";
import { isAiAgentId } from "@/lib/agents";
import { collectOpenProjects, projectPathKey } from "@/lib/openProjects";
import type { ProjectInfo } from "@/store/utils/recentProjects";

const PROJECT_NAME_COLLATOR = new Intl.Collator("en", { sensitivity: "accent" });

export function collectTaskMonitorProjects(
  contexts: WindowProjectContext[],
  current: ProjectInfo | null,
): ProjectInfo[] {
  // 优先使用各窗口共享的项目名称，当前项目只在窗口信息尚未同步时补齐。
  const projects = collectOpenProjects(contexts, null);
  if (current && !projects.some((project) => projectPathKey(project.path) === projectPathKey(current.path))) {
    projects.push(current);
  }
  return projects.sort((left, right) => {
    // 固定排序语言，避免窗口语言或焦点变化影响顺序；同名项目按完整路径排序。
    const byName = PROJECT_NAME_COLLATOR.compare(left.name, right.name);
    if (byName !== 0) return byName;
    const leftPath = projectPathKey(left.path);
    const rightPath = projectPathKey(right.path);
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
}

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
