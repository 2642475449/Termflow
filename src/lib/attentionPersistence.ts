import type { Session } from "@/types";
import type { AttentionItem } from "./attention";

export const ATTENTION_OPEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const ATTENTION_TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1000;

const PERSISTED_KINDS = new Set<AttentionItem["kind"]>(["completion", "failure"]);

function normalizedProjectPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

function retainedAt(item: AttentionItem): number {
  return Math.max(item.updatedAt, item.resolvedAt ?? 0);
}

/**
 * Keeps only restart-safe attention state. Runtime permission/input prompts are
 * deliberately discarded because their backing process state cannot be proven
 * after a restart.
 */
export function sanitizePersistedAttentionItems(
  itemsByProject: Readonly<Record<string, readonly AttentionItem[]>> | undefined,
  sessionsByProject: Readonly<Record<string, readonly Session[]>> | undefined,
  now = Date.now()
): Record<string, AttentionItem[]> {
  if (!itemsByProject || !sessionsByProject) return {};

  const sessionsByNormalizedProject = new Map<string, Map<string, Session>>();
  for (const [projectPath, sessions] of Object.entries(sessionsByProject)) {
    sessionsByNormalizedProject.set(
      normalizedProjectPath(projectPath),
      new Map(sessions.filter((session) => !session.archived).map((session) => [session.id, session]))
    );
  }

  const sanitized: Record<string, AttentionItem[]> = {};
  for (const [projectPath, items] of Object.entries(itemsByProject)) {
    const sessions = sessionsByNormalizedProject.get(normalizedProjectPath(projectPath));
    if (!sessions) continue;

    const latestBySession = new Map<string, AttentionItem>();
    for (const item of items) {
      if (!PERSISTED_KINDS.has(item.kind) || !sessions.has(item.sessionId)) continue;
      if (normalizedProjectPath(item.projectPath) !== normalizedProjectPath(projectPath)) continue;

      const retentionMs =
        item.disposition === "open"
          ? ATTENTION_OPEN_RETENTION_MS
          : ATTENTION_TOMBSTONE_RETENTION_MS;
      const age = now - retainedAt(item);
      if (!Number.isFinite(age) || age < 0 || age > retentionMs) continue;

      const previous = latestBySession.get(item.sessionId);
      if (!previous || retainedAt(item) > retainedAt(previous)) {
        latestBySession.set(item.sessionId, item);
      }
    }

    const projectItems = [...latestBySession.values()].sort(
      (left, right) => left.priority - right.priority || right.updatedAt - left.updatedAt
    );
    if (projectItems.length > 0) sanitized[projectPath] = projectItems;
  }

  return sanitized;
}

interface PersistableSessionEvent {
  id: string;
  dedupeKey?: string | null;
  createdAt: number;
  requiresAttention: boolean;
}

/**
 * Bounds the persisted event stream and removes sources already represented by
 * a resolved/dismissed tombstone. This prevents an old event from reopening as
 * soon as its short-lived tombstone expires.
 */
export function sanitizePersistedSessionEvents<T extends PersistableSessionEvent>(
  events: readonly T[],
  attentionItems: Readonly<Record<string, readonly AttentionItem[]>>,
  now = Date.now()
): T[] {
  const closedSources = new Set(
    Object.values(attentionItems)
      .flat()
      .filter((item) => item.disposition !== "open")
      .map((item) => item.sourceDedupeKey)
  );

  return events.filter((event) => {
    const age = now - event.createdAt;
    if (!Number.isFinite(age) || age < 0 || age > ATTENTION_OPEN_RETENTION_MS) return false;
    const sourceKey = event.dedupeKey?.trim() || event.id;
    return !event.requiresAttention || !closedSources.has(sourceKey);
  });
}
