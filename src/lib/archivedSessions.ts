import type { AgentId, Session } from "@/types";

export type AgentFilter = "all" | AgentId;
export type ArchiveSort = "recent" | "oldest" | "name";

export type ArchivedRow = {
  projectPath: string;
  projectName: string;
  session: Session;
};

const SUPPORTED_AGENT_IDS = new Set<AgentId>([
  "claude",
  "codex",
  "antigravity",
  "opencode",
  "qoder",
  "pi",
  "powershell",
  "cmd",
]);

/**
 * Archived sessions are persisted locally and can outlive changes to the
 * agent registry. Normalize them before rendering so a removed agent id
 * cannot take down the whole settings page.
 */
export function normalizeArchivedSessionGroups(value: unknown): Record<string, Session[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value).flatMap(([projectPath, sessions]) => {
      if (!Array.isArray(sessions)) return [];

      const normalizedSessions = sessions.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
        const session = candidate as Record<string, unknown>;
        if (typeof session.id !== "string" || !session.id) return [];

        const agentId = SUPPORTED_AGENT_IDS.has(session.agentId as AgentId)
          ? session.agentId as AgentId
          : undefined;

        return [{
          ...session,
          id: session.id,
          name: typeof session.name === "string" && session.name ? session.name : session.id,
          path: typeof session.path === "string" ? session.path : projectPath,
          createdAt: typeof session.createdAt === "number" ? session.createdAt : 0,
          active: false,
          status: "stopped" as const,
          archived: true,
          agentId,
        } as Session];
      });

      return [[projectPath, normalizedSessions]];
    })
  );
}

type ArchiveFilterOptions = {
  query: string;
  agent: AgentFilter;
  project: string;
  sort: ArchiveSort;
};

export function filterAndSortArchivedRows(rows: ArchivedRow[], options: ArchiveFilterOptions) {
  const normalizedQuery = options.query.trim().toLocaleLowerCase();

  return rows
    .filter((row) => options.project === "all" || row.projectPath === options.project)
    .filter((row) => options.agent === "all" || (row.session.agentId ?? "claude") === options.agent)
    .filter((row) => {
      if (!normalizedQuery) return true;
      return [row.session.name, row.session.path, row.projectName]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    })
    .sort((left, right) => {
      if (options.sort === "name") return left.session.name.localeCompare(right.session.name);
      const leftTime = left.session.archivedAt ?? 0;
      const rightTime = right.session.archivedAt ?? 0;
      return options.sort === "oldest" ? leftTime - rightTime : rightTime - leftTime;
    });
}
