import { describe, expect, it } from "vitest";
import type { Session } from "@/types";
import type { AttentionItem } from "./attention";
import {
  ATTENTION_OPEN_RETENTION_MS,
  ATTENTION_TOMBSTONE_RETENTION_MS,
  sanitizePersistedAttentionItems,
  sanitizePersistedSessionEvents,
} from "./attentionPersistence";

const NOW = 2_000_000_000_000;
const PROJECT = "D:/workspace/demo";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    path: PROJECT,
    name: "Demo",
    createdAt: NOW - 1000,
    active: true,
    status: "completed",
    agentId: "codex",
    ...overrides,
  };
}

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "attention:event-1",
    sourceEventId: "event-1",
    sourceDedupeKey: "event-1",
    sourceRevision: 1,
    projectPath: PROJECT,
    sessionId: "session-1",
    sessionName: "Demo",
    agentId: "codex",
    kind: "completion",
    disposition: "open",
    priority: 3,
    title: "Completed",
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    ...overrides,
  };
}

describe("attention persistence", () => {
  it("keeps recent completion/failure items and drops runtime prompts", () => {
    const result = sanitizePersistedAttentionItems(
      {
        [PROJECT]: [
          item(),
          item({ id: "failure", sessionId: "session-2", kind: "failure", priority: 2 }),
          item({ id: "permission", sessionId: "session-3", kind: "permission", priority: 1 }),
        ],
      },
      {
        [PROJECT]: [session(), session({ id: "session-2" }), session({ id: "session-3" })],
      },
      NOW
    );

    expect(result[PROJECT].map((entry) => entry.kind)).toEqual(["failure", "completion"]);
  });

  it("drops missing, archived and expired session items", () => {
    const result = sanitizePersistedAttentionItems(
      {
        [PROJECT]: [
          item({ sessionId: "missing" }),
          item({ sessionId: "archived" }),
          item({ updatedAt: NOW - ATTENTION_OPEN_RETENTION_MS - 1 }),
        ],
      },
      { [PROJECT]: [session(), session({ id: "archived", archived: true })] },
      NOW
    );

    expect(result).toEqual({});
  });

  it("retains closed tombstones briefly and then expires them", () => {
    const recent = item({
      disposition: "resolved",
      resolvedAt: NOW - 1000,
      updatedAt: NOW - 1000,
    });
    const expired = item({
      id: "old",
      sessionId: "session-2",
      disposition: "dismissed",
      updatedAt: NOW - ATTENTION_TOMBSTONE_RETENTION_MS - 1,
    });

    const result = sanitizePersistedAttentionItems(
      { [PROJECT]: [recent, expired] },
      { [PROJECT]: [session(), session({ id: "session-2" })] },
      NOW
    );

    expect(result[PROJECT]).toEqual([recent]);
  });

  it("removes expired events and sources closed by a tombstone", () => {
    const events = [
      { id: "event-1", createdAt: NOW - 1000, requiresAttention: true },
      { id: "runtime", createdAt: NOW - 1000, requiresAttention: false },
      {
        id: "expired",
        createdAt: NOW - ATTENTION_OPEN_RETENTION_MS - 1,
        requiresAttention: false,
      },
    ];
    const closed = item({
      disposition: "resolved",
      updatedAt: NOW - ATTENTION_TOMBSTONE_RETENTION_MS - 1,
    });

    expect(sanitizePersistedSessionEvents(events, { [PROJECT]: [closed] }, NOW)).toEqual([
      events[1],
    ]);
  });
});
