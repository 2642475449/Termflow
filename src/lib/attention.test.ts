import { describe, expect, it } from "vitest";
import type { Session } from "@/types";
import {
  filterAttentionItems,
  indexOpenAttentionItemsBySession,
  markAttentionForSessionViewed,
  mergeAttentionProjection,
  projectAttentionItems,
  transitionAttentionItems,
  type AttentionSourceEvent,
} from "./attention";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    path: "D:/workspace/demo",
    name: "修复登录超时",
    createdAt: 10,
    active: true,
    status: "waiting",
    agentId: "codex",
    ...overrides,
  };
}

function event(overrides: Partial<AttentionSourceEvent> = {}): AttentionSourceEvent {
  return {
    id: "event-1",
    revision: 1,
    sessionId: "session-1",
    projectPath: "D:/workspace/demo",
    sessionName: "修复登录超时",
    eventType: "waiting_input",
    title: "等待你操作",
    body: "打开会话继续处理",
    source: "codex",
    requiresAttention: true,
    createdAt: 100,
    ...overrides,
  };
}

describe("projectAttentionItems", () => {
  it("projects only supported attention events", () => {
    const items = projectAttentionItems(
      [
        event({ id: "started", eventType: "session_started" }),
        event({ id: "passive", requiresAttention: false }),
        event(),
      ],
      [session()]
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceEventId: "event-1",
      kind: "input",
      disposition: "open",
      priority: 1,
    });
  });

  it("keeps one item per Session and prefers a permission upgrade", () => {
    const items = projectAttentionItems(
      [
        event({ id: "waiting", eventType: "waiting_input", revision: 4 }),
        event({
          id: "permission",
          dedupeKey: "permission-key",
          eventType: "permission_request",
          title: "等待授权",
          revision: 4,
        }),
      ],
      [session({ statusRevision: 4 })]
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "attention:permission-key",
      sourceEventId: "permission",
      kind: "permission",
      disposition: "open",
    });
  });

  it("resolves a previous item only after a newer running revision", () => {
    const source = event({ revision: 7, createdAt: 700 });

    expect(
      projectAttentionItems(
        [source],
        [session({ status: "running", statusRevision: 7, statusUpdatedAt: 701 })]
      )[0].disposition
    ).toBe("open");

    expect(
      projectAttentionItems(
        [source],
        [session({ status: "running", statusRevision: 8, statusUpdatedAt: 800 })]
      )[0]
    ).toMatchObject({
      disposition: "resolved",
      resolvedAt: 800,
      resolutionReason: "new-run-started",
    });
  });

  it("resolves only a completion observed in the foreground", () => {
    const items = projectAttentionItems(
      [
        event({
          sessionId: "session-1",
          eventType: "waiting_input",
          read: true,
        }),
        event({
          id: "complete",
          sessionId: "session-2",
          sessionName: "补充测试",
          eventType: "assistant_complete",
          source: "claude",
          read: true,
          observedAtDelivery: true,
        }),
      ],
      [session(), session({ id: "session-2", name: "补充测试", agentId: "claude" })]
    );

    expect(items.find((item) => item.sessionId === "session-1")).toMatchObject({
      disposition: "open",
      seenAt: 100,
    });
    expect(items.find((item) => item.sessionId === "session-2")).toMatchObject({
      disposition: "resolved",
      seenAt: 100,
      resolutionReason: "observed-in-foreground",
    });
  });

  it("does not confuse a later read flag with foreground observation", () => {
    const [item] = projectAttentionItems(
      [event({ eventType: "assistant_complete", read: true })],
      [session({ status: "completed" })]
    );

    expect(item).toMatchObject({
      kind: "completion",
      disposition: "open",
      seenAt: 100,
    });
  });

  it("sorts open work by priority and strips unapproved metadata", () => {
    const items = projectAttentionItems(
      [
        event({
          id: "complete",
          sessionId: "session-2",
          sessionName: "补充测试",
          eventType: "assistant_complete",
          source: "claude",
          createdAt: 300,
        }),
        event({
          id: "error",
          sessionId: "session-3",
          sessionName: "处理错误",
          eventType: "process_error",
          source: "antigravity",
          createdAt: 200,
          metadata: { durationMs: 1200, exitCode: 1, prompt: "secret" },
        }),
        event({ id: "permission", eventType: "permission_request", createdAt: 100 }),
      ],
      [
        session(),
        session({ id: "session-2", name: "补充测试", agentId: "claude" }),
        session({ id: "session-3", name: "处理错误", agentId: "antigravity" }),
      ]
    );

    expect(items.map((item) => item.kind)).toEqual(["permission", "failure", "completion"]);
    expect(items[1].metadata).toEqual({ durationMs: 1200, exitCode: 1 });
  });

  it("does not project deleted Sessions or non-agent terminal Sessions", () => {
    expect(projectAttentionItems([event()], [])).toEqual([]);
    expect(projectAttentionItems([event({ source: "unknown" })], [session({ agentId: "cmd" })])).toEqual([]);
  });

  it("preserves seen and dismissed decisions for the same source event", () => {
    const projected = projectAttentionItems([event()], [session()]);
    const existing = [{
      ...projected[0],
      disposition: "dismissed" as const,
      seenAt: 150,
      resolvedAt: 160,
      resolutionReason: "dismissed-by-user",
      updatedAt: 160,
    }];

    expect(mergeAttentionProjection(projected, existing)[0]).toMatchObject({
      disposition: "dismissed",
      seenAt: 150,
      resolvedAt: 160,
      resolutionReason: "dismissed-by-user",
    });
  });

  it("resolves completion on view but only marks waiting as seen", () => {
    const items = projectAttentionItems(
      [
        event(),
        event({
          id: "complete",
          sessionId: "session-2",
          sessionName: "补充测试",
          eventType: "assistant_complete",
          source: "claude",
        }),
      ],
      [session(), session({ id: "session-2", name: "补充测试", agentId: "claude" })]
    );
    const waitingViewed = markAttentionForSessionViewed(items, "session-1", 200);
    const completionViewed = markAttentionForSessionViewed(waitingViewed, "session-2", 210);

    expect(completionViewed.find((item) => item.sessionId === "session-1")).toMatchObject({
      disposition: "open",
      seenAt: 200,
    });
    expect(completionViewed.find((item) => item.sessionId === "session-2")).toMatchObject({
      disposition: "resolved",
      seenAt: 210,
      resolutionReason: "session-opened",
    });
  });

  it("applies explicit lifecycle transitions only to open matching items", () => {
    const items = projectAttentionItems([event()], [session()]);
    const resolved = transitionAttentionItems(
      items,
      (item) => item.sessionId === "session-1",
      "expired",
      "session-deleted",
      300
    );

    expect(resolved[0]).toMatchObject({
      disposition: "expired",
      resolvedAt: 300,
      resolutionReason: "session-deleted",
    });
  });

  it("filters only open items into the four MVP views", () => {
    const items = projectAttentionItems(
      [
        event({ id: "permission", eventType: "permission_request" }),
        event({
          id: "failure",
          sessionId: "session-2",
          sessionName: "错误会话",
          eventType: "process_error",
          source: "claude",
        }),
        event({
          id: "complete",
          sessionId: "session-3",
          sessionName: "完成会话",
          eventType: "assistant_complete",
          source: "antigravity",
        }),
      ],
      [
        session(),
        session({ id: "session-2", name: "错误会话", agentId: "claude" }),
        session({ id: "session-3", name: "完成会话", agentId: "antigravity" }),
      ]
    );
    const withResolvedFailure = items.map((item) =>
      item.kind === "failure" ? { ...item, disposition: "resolved" as const } : item
    );

    expect(filterAttentionItems(withResolvedFailure, "all").map((item) => item.kind)).toEqual([
      "permission",
      "completion",
    ]);
    expect(filterAttentionItems(withResolvedFailure, "waiting")).toHaveLength(1);
    expect(filterAttentionItems(withResolvedFailure, "failure")).toHaveLength(0);
    expect(filterAttentionItems(withResolvedFailure, "completion")).toHaveLength(1);
  });

  it("indexes one highest-priority open status per Session for the Session list", () => {
    const items = projectAttentionItems(
      [
        event({ id: "complete", eventType: "assistant_complete", revision: 2 }),
        event({ id: "permission", eventType: "permission_request", revision: 3 }),
        event({
          id: "other-complete",
          sessionId: "session-2",
          eventType: "assistant_complete",
          revision: 1,
          source: "claude",
        }),
      ],
      [session(), session({ id: "session-2", agentId: "claude" })]
    );
    const resolvedOther = items.map((item) =>
      item.sessionId === "session-2"
        ? { ...item, disposition: "resolved" as const }
        : item
    );

    const indexed = indexOpenAttentionItemsBySession(resolvedOther);

    expect(indexed.size).toBe(1);
    expect(indexed.get("session-1")?.kind).toBe("permission");
    expect(indexed.has("session-2")).toBe(false);
  });
});
