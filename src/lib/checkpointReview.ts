import type { AgentTurnReview, Session } from "@/types";

const OPEN_REVIEW_STATUSES = new Set(["awaiting_review", "partially_reviewed"]);
export const OPEN_CHECKPOINT_REVIEW_EVENT = "termflow:open-checkpoint-review";

export type CheckpointSummaryTone =
  | "pending"
  | "partial"
  | "reviewed"
  | "restored";

export interface CheckpointSummaryModel {
  tone: CheckpointSummaryTone;
  pendingTurns: number;
  files: number;
  additions: number;
  deletions: number;
  touchedLines: number;
  netLines: number;
}

export interface RemainingCheckpointStats {
  files: number;
  additions: number;
  deletions: number;
}

export function getRemainingCheckpointStats(turn: AgentTurnReview): RemainingCheckpointStats {
  return turn.files.reduce<RemainingCheckpointStats>((summary, file) => {
    if (file.decision === "rejected") return summary;
    summary.files += 1;
    summary.additions += file.insertions ?? 0;
    summary.deletions += file.deletions ?? 0;
    return summary;
  }, { files: 0, additions: 0, deletions: 0 });
}

export function getCheckpointSummaryModel(session: Session): CheckpointSummaryModel | null {
  const pendingTurns = session.checkpointPendingTurns ?? 0;
  const files = session.checkpointFileCount ?? 0;

  // Checkpoint creation is background bookkeeping, not an actionable event.
  // Stay quiet until there is an actual file change to review, and do not keep
  // an empty completed turn in the session chrome.
  if (pendingTurns === 0 && session.checkpointActiveTurnId) return null;
  if (pendingTurns === 0 && session.checkpointReviewStatus === "no_changes") return null;
  if (pendingTurns === 0 && files === 0) return null;

  const additions = session.checkpointInsertions ?? 0;
  const deletions = session.checkpointDeletions ?? 0;
  let tone: CheckpointSummaryTone;
  if (pendingTurns > 0) {
    tone = session.checkpointReviewStatus === "partially_reviewed" ? "partial" : "pending";
  } else if (session.checkpointReviewStatus === "restored") {
    tone = "restored";
  } else {
    tone = "reviewed";
  }

  return {
    tone,
    pendingTurns,
    files,
    additions,
    deletions,
    touchedLines: additions + deletions,
    netLines: additions - deletions,
  };
}

export function openCheckpointReview(sessionId: string): void {
  window.dispatchEvent(
    new CustomEvent(OPEN_CHECKPOINT_REVIEW_EVENT, { detail: { sessionId } }),
  );
}

export function isOpenCheckpointReview(turn: AgentTurnReview): boolean {
  return turn.files.length > 0 && OPEN_REVIEW_STATUSES.has(turn.reviewStatus);
}

export function checkpointSessionUpdates(
  turns: AgentTurnReview[],
): Partial<Session> {
  const pending = turns.filter(isOpenCheckpointReview);
  const latest = pending[0] ?? turns[0] ?? null;
  const remaining = latest ? getRemainingCheckpointStats(latest) : null;
  return {
    checkpointActiveTurnId:
      turns.find((turn) => turn.reviewStatus === "running")?.id ?? null,
    checkpointPendingTurns: pending.length,
    checkpointFileCount: remaining?.files ?? 0,
    checkpointInsertions: remaining?.additions ?? 0,
    checkpointDeletions: remaining?.deletions ?? 0,
    checkpointReviewStatus: latest?.reviewStatus ?? null,
    checkpointUpdatedAt: latest?.updatedAt ?? Date.now(),
  };
}
