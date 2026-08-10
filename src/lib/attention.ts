import type { AiAgentId, Session } from "@/types";
import { isAiAgentId } from "@/lib/agents";

export type AttentionKind = "permission" | "input" | "completion" | "failure";

export type AttentionDisposition = "open" | "resolved" | "dismissed" | "expired";
export type AttentionFilter = "all" | "waiting" | "failure" | "completion";

export interface AttentionSourceEvent {
  id: string;
  revision?: number | null;
  sessionId: string;
  projectPath: string;
  sessionName: string;
  eventType: string;
  title: string;
  body: string;
  source: string;
  requiresAttention: boolean;
  dedupeKey?: string | null;
  createdAt: number;
  metadata?: Record<string, unknown>;
  read?: boolean;
  observedAtDelivery?: boolean;
}

export interface AttentionItem {
  id: string;
  sourceEventId: string;
  sourceDedupeKey: string;
  sourceRevision: number;
  projectPath: string;
  sessionId: string;
  sessionName: string;
  agentId: AiAgentId;
  kind: AttentionKind;
  disposition: AttentionDisposition;
  priority: 1 | 2 | 3;
  title: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  seenAt?: number;
  resolvedAt?: number;
  resolutionReason?: string;
  metadata?: {
    durationMs?: number;
    exitCode?: number;
  };
}

interface AttentionSemantics {
  kind: AttentionKind;
  priority: 1 | 2 | 3;
}

const ATTENTION_EVENT_SEMANTICS: Readonly<Record<string, AttentionSemantics>> = {
  permission_request: { kind: "permission", priority: 1 },
  waiting_input: { kind: "input", priority: 1 },
  process_error: { kind: "failure", priority: 2 },
  hook_error: { kind: "failure", priority: 2 },
  assistant_complete: { kind: "completion", priority: 3 },
};

function eventRevision(event: AttentionSourceEvent): number {
  return typeof event.revision === "number" && Number.isFinite(event.revision)
    ? event.revision
    : 0;
}

function compareEventRecency(left: AttentionSourceEvent, right: AttentionSourceEvent): number {
  const revisionDifference = eventRevision(left) - eventRevision(right);
  if (revisionDifference !== 0) return revisionDifference;

  const timeDifference = left.createdAt - right.createdAt;
  if (timeDifference !== 0) return timeDifference;

  // A permission request is more precise than a generic waiting event emitted
  // for the same state transition, so retain it when both arrive together.
  const leftSpecificity = left.eventType === "permission_request" ? 1 : 0;
  const rightSpecificity = right.eventType === "permission_request" ? 1 : 0;
  if (leftSpecificity !== rightSpecificity) return leftSpecificity - rightSpecificity;

  return left.id.localeCompare(right.id);
}

function statusSupersedesEvent(session: Session, event: AttentionSourceEvent): boolean {
  if (session.status !== "running") return false;

  const statusRevision = session.statusRevision ?? 0;
  const sourceRevision = eventRevision(event);
  if (statusRevision > 0 && sourceRevision > 0) {
    return statusRevision > sourceRevision;
  }

  return (session.statusUpdatedAt ?? 0) > event.createdAt;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeMetadata(
  metadata: Record<string, unknown> | undefined
): AttentionItem["metadata"] | undefined {
  const durationMs = safeNumber(metadata?.durationMs);
  const exitCode = safeNumber(metadata?.exitCode);
  if (durationMs === undefined && exitCode === undefined) return undefined;
  return { durationMs, exitCode };
}

function projectEvent(event: AttentionSourceEvent, session: Session): AttentionItem | null {
  const semantics = ATTENTION_EVENT_SEMANTICS[event.eventType];
  if (!event.requiresAttention || !semantics) return null;

  const agentId = isAiAgentId(session.agentId)
    ? session.agentId
    : isAiAgentId(event.source)
      ? event.source
      : null;
  if (!agentId) return null;

  let disposition: AttentionDisposition = "open";
  let resolvedAt: number | undefined;
  let resolutionReason: string | undefined;

  if (session.archived) {
    disposition = "resolved";
    resolvedAt = session.archivedAt ?? session.statusUpdatedAt ?? event.createdAt;
    resolutionReason = "session-archived";
  } else if (statusSupersedesEvent(session, event)) {
    disposition = "resolved";
    resolvedAt = session.statusUpdatedAt;
    resolutionReason = "new-run-started";
  } else if (semantics.kind === "completion" && event.observedAtDelivery) {
    disposition = "resolved";
    resolvedAt = event.createdAt;
    resolutionReason = "observed-in-foreground";
  }

  return {
    id: `attention:${event.dedupeKey ?? event.id}`,
    sourceEventId: event.id,
    sourceDedupeKey: event.dedupeKey ?? event.id,
    sourceRevision: eventRevision(event),
    projectPath: event.projectPath,
    sessionId: event.sessionId,
    sessionName: event.sessionName || session.name,
    agentId,
    kind: semantics.kind,
    disposition,
    priority: semantics.priority,
    title: event.title,
    description: event.body || undefined,
    createdAt: event.createdAt,
    updatedAt: resolvedAt ?? event.createdAt,
    seenAt: event.read ? event.createdAt : undefined,
    resolvedAt,
    resolutionReason,
    metadata: safeMetadata(event.metadata),
  };
}

/**
 * Projects the retained event stream into at most one current item per Session.
 * The function is deterministic and has no Store or browser side effects.
 */
export function projectAttentionItems(
  events: readonly AttentionSourceEvent[],
  sessions: readonly Session[]
): AttentionItem[] {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const latestBySession = new Map<string, AttentionSourceEvent>();

  for (const event of events) {
    if (!event.requiresAttention || !ATTENTION_EVENT_SEMANTICS[event.eventType]) continue;
    if (!sessionsById.has(event.sessionId)) continue;

    const current = latestBySession.get(event.sessionId);
    if (!current || compareEventRecency(event, current) > 0) {
      latestBySession.set(event.sessionId, event);
    }
  }

  return [...latestBySession.values()]
    .map((event) => projectEvent(event, sessionsById.get(event.sessionId)!))
    .filter((item): item is AttentionItem => item !== null)
    .sort((left, right) => left.priority - right.priority || right.updatedAt - left.updatedAt);
}

/** Preserves user decisions while applying a fresh event/session projection. */
export function mergeAttentionProjection(
  projected: readonly AttentionItem[],
  existing: readonly AttentionItem[]
): AttentionItem[] {
  const existingBySource = new Map(existing.map((item) => [item.sourceDedupeKey, item]));

  return projected.map((item) => {
    const previous = existingBySource.get(item.sourceDedupeKey);
    if (!previous) return item;

    const userDisposition =
      previous.disposition === "dismissed" ||
      previous.disposition === "resolved" ||
      previous.disposition === "expired";
    if (userDisposition && item.disposition === "open") {
      return {
        ...item,
        disposition: previous.disposition,
        seenAt: previous.seenAt,
        resolvedAt: previous.resolvedAt,
        resolutionReason: previous.resolutionReason,
        updatedAt: Math.max(item.updatedAt, previous.updatedAt),
      };
    }

    return {
      ...item,
      seenAt: previous.seenAt,
      updatedAt: Math.max(item.updatedAt, previous.updatedAt),
    };
  });
}

export function markAttentionForSessionViewed(
  items: readonly AttentionItem[],
  sessionId: string,
  viewedAt: number
): AttentionItem[] {
  return items.map((item) => {
    if (item.sessionId !== sessionId || item.disposition !== "open") return item;
    if (item.kind === "completion") {
      return {
        ...item,
        disposition: "resolved",
        seenAt: item.seenAt ?? viewedAt,
        resolvedAt: viewedAt,
        resolutionReason: "session-opened",
        updatedAt: viewedAt,
      };
    }
    return item.seenAt === undefined
      ? { ...item, seenAt: viewedAt, updatedAt: Math.max(item.updatedAt, viewedAt) }
      : item;
  });
}

export function transitionAttentionItems(
  items: readonly AttentionItem[],
  predicate: (item: AttentionItem) => boolean,
  disposition: "resolved" | "dismissed" | "expired",
  reason: string,
  transitionedAt: number
): AttentionItem[] {
  return items.map((item) =>
    predicate(item) && item.disposition === "open"
      ? {
          ...item,
          disposition,
          resolvedAt: transitionedAt,
          resolutionReason: reason,
          updatedAt: transitionedAt,
        }
      : item
  );
}

export function selectOpenAttentionItems(
  items: readonly AttentionItem[]
): AttentionItem[] {
  return items.filter((item) => item.disposition === "open");
}

/** Provides the single actionable status rendered beside each Session row. */
export function indexOpenAttentionItemsBySession(
  items: readonly AttentionItem[]
): Map<string, AttentionItem> {
  const indexed = new Map<string, AttentionItem>();
  for (const item of items) {
    if (item.disposition !== "open") continue;
    const current = indexed.get(item.sessionId);
    if (
      !current ||
      item.priority < current.priority ||
      (item.priority === current.priority && item.updatedAt > current.updatedAt)
    ) {
      indexed.set(item.sessionId, item);
    }
  }
  return indexed;
}

export function filterAttentionItems(
  items: readonly AttentionItem[],
  filter: AttentionFilter
): AttentionItem[] {
  const openItems = selectOpenAttentionItems(items);
  if (filter === "all") return openItems;
  if (filter === "waiting") {
    return openItems.filter((item) => item.kind === "permission" || item.kind === "input");
  }
  return openItems.filter((item) => item.kind === filter);
}
