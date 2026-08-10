import { describe, expect, it } from "vitest";
import {
  checkpointSessionUpdates,
  getRemainingCheckpointStats,
  getCheckpointSummaryModel,
  isOpenCheckpointReview,
} from "./checkpointReview";
import type { Session } from "@/types";
import type { AgentTurnReview } from "@/types";

function turn(id: string, status: AgentTurnReview["reviewStatus"], files = 1): AgentTurnReview {
  return {
    version: 1,
    id,
    sessionId: "session",
    agentId: "generic",
    projectPath: "C:/repo",
    startedAt: Number(id),
    completedAt: 2,
    completionSource: "test",
    attributionConfidence: "medium",
    baseline: { commitOid: "a", treeOid: "a", reference: "a", createdAt: 1 },
    result: { commitOid: "b", treeOid: "b", reference: "b", createdAt: 2 },
    files: Array.from({ length: files }, (_, index) => ({
      path: `${index}.ts`, oldPath: null, status: "modified", insertions: 1,
      deletions: 0, isBinary: false, decision: "pending",
    })),
    hunkDecisions: {}, insertions: files, deletions: 0,
    reviewStatus: status, reviewedAt: null, updatedAt: Number(id),
  };
}

describe("checkpoint review summaries", () => {
  it("only counts actionable reviews", () => {
    expect(isOpenCheckpointReview(turn("1", "no_changes", 0))).toBe(false);
    expect(isOpenCheckpointReview(turn("2", "awaiting_review"))).toBe(true);
    const summary = checkpointSessionUpdates([
      turn("3", "reviewed"),
      turn("2", "partially_reviewed", 2),
      turn("1", "awaiting_review", 3),
    ]);
    expect(summary.checkpointPendingTurns).toBe(2);
    expect(summary.checkpointFileCount).toBe(2);
  });

  it("builds a compact current-turn summary", () => {
    const session = {
      id: "session",
      path: "C:/repo",
      name: "Session",
      createdAt: 1,
      active: true,
      checkpointPendingTurns: 2,
      checkpointFileCount: 3,
      checkpointInsertions: 82,
      checkpointDeletions: 19,
      checkpointReviewStatus: "awaiting_review",
      checkpointUpdatedAt: 2,
    } satisfies Session;
    expect(getCheckpointSummaryModel(session)).toEqual({
      tone: "pending",
      pendingTurns: 2,
      files: 3,
      additions: 82,
      deletions: 19,
      touchedLines: 101,
      netLines: 63,
    });
  });

  it("hides checkpoint bookkeeping when a running turn has no file changes", () => {
    const session = {
      id: "session",
      path: "C:/repo",
      name: "Session",
      createdAt: 1,
      active: true,
      checkpointActiveTurnId: "running-turn",
    } satisfies Session;
    expect(getCheckpointSummaryModel(session)).toBeNull();
  });

  it("hides a completed turn with no file changes", () => {
    const session = {
      id: "session",
      path: "C:/repo",
      name: "Session",
      createdAt: 1,
      active: true,
      checkpointReviewStatus: "no_changes",
      checkpointUpdatedAt: 2,
    } satisfies Session;
    expect(getCheckpointSummaryModel(session)).toBeNull();
  });

  it("keeps older pending changes visible while a new turn is running", () => {
    const session = {
      id: "session",
      path: "C:/repo",
      name: "Session",
      createdAt: 1,
      active: true,
      checkpointActiveTurnId: "running-turn",
      checkpointPendingTurns: 1,
      checkpointFileCount: 2,
      checkpointInsertions: 8,
      checkpointDeletions: 3,
      checkpointReviewStatus: "running",
    } satisfies Session;
    expect(getCheckpointSummaryModel(session)).toMatchObject({
      tone: "pending",
      pendingTurns: 1,
      files: 2,
    });
  });

  it("keeps older pending changes visible after a newer empty turn", () => {
    const session = {
      id: "session",
      path: "C:/repo",
      name: "Session",
      createdAt: 1,
      active: true,
      checkpointPendingTurns: 1,
      checkpointFileCount: 1,
      checkpointInsertions: 4,
      checkpointDeletions: 1,
      checkpointReviewStatus: "no_changes",
    } satisfies Session;
    expect(getCheckpointSummaryModel(session)?.tone).toBe("pending");
  });

  it("removes rejected files from remaining change statistics", () => {
    const reviewed = turn("4", "reviewed", 2);
    reviewed.files[0].insertions = 24;
    reviewed.files[0].deletions = 3;
    reviewed.files[0].decision = "rejected";
    reviewed.files[1].insertions = 7;
    reviewed.files[1].deletions = 2;
    reviewed.files[1].decision = "accepted";

    expect(getRemainingCheckpointStats(reviewed)).toEqual({
      files: 1,
      additions: 7,
      deletions: 2,
    });
    expect(checkpointSessionUpdates([reviewed])).toMatchObject({
      checkpointFileCount: 1,
      checkpointInsertions: 7,
      checkpointDeletions: 2,
    });
  });
});
