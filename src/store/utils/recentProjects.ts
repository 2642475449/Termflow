import type { Session } from "@/types";
import { toPersistedSession } from "@/lib/sessions";

export interface ProjectInfo {
  path: string;
  name: string;
}

export interface RecentProjectEntry extends ProjectInfo {
  lastOpenedAt: number;
}

export interface PersistedRecentProjectState {
  projectSessions?: Record<string, Session[]>;
  recentProjects?: RecentProjectEntry[];
}

export const RECENT_PROJECT_LIMIT = 10;

export function touchRecentProjects(
  recentProjects: RecentProjectEntry[],
  project: ProjectInfo,
  now = Date.now()
) {
  return [
    { ...project, lastOpenedAt: now },
    ...recentProjects.filter((item) => item.path !== project.path),
  ]
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, RECENT_PROJECT_LIMIT);
}

export function deriveLegacyRecentProjects(
  projectSessions: Record<string, Session[]>,
  existingRecentProjects?: RecentProjectEntry[]
) {
  const baseEntries =
    existingRecentProjects && existingRecentProjects.length > 0
      ? existingRecentProjects
      : Object.entries(projectSessions).map(([path, sessions]) => {
          const lastOpenedAt = sessions.reduce((latest, session) => {
            const candidate = Math.max(
              session.lastEventAt ?? 0,
              session.createdAt ?? 0
            );
            return Math.max(latest, candidate);
          }, 0);
          return {
            path,
            name: path.split(/[\\/]/).pop() || path,
            lastOpenedAt,
          };
        });

  return [...baseEntries]
    .filter((item) => item.path.trim().length > 0)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, RECENT_PROJECT_LIMIT);
}

export function migrateRecentProjectState(
  persistedState: PersistedRecentProjectState | undefined
) {
  if (!persistedState) return persistedState;

  return {
    ...persistedState,
    recentProjects: deriveLegacyRecentProjects(
      persistedState.projectSessions ?? {},
      persistedState.recentProjects ?? []
    ),
  };
}

export function normalizeRehydratedProjectSessions(
  projectSessions: Record<string, Session[]> = {}
) {
  const normalizedProjectSessions: Record<string, Session[]> = {};
  for (const [path, sessions] of Object.entries(projectSessions)) {
    normalizedProjectSessions[path] = sessions.map((session) =>
      toPersistedSession({
        ...session,
        agentId: (session.agentId as string) === "gemini" ? "antigravity" : session.agentId,
      })
    );
  }
  return normalizedProjectSessions;
}

export function rehydrateRecentProjectState(
  persistedState: PersistedRecentProjectState | undefined
) {
  const normalizedProjectSessions = normalizeRehydratedProjectSessions(
    persistedState?.projectSessions ?? {}
  );

  return {
    normalizedProjectSessions,
    recentProjects: deriveLegacyRecentProjects(
      normalizedProjectSessions,
      persistedState?.recentProjects
    ),
  };
}
