import { describe, expect, it, vi } from "vitest";
import type { StateStorage } from "zustand/middleware";
import type { Session } from "@/types";
import type { AttentionItem } from "@/lib/attention";
import { createAppStore } from "./index";

const NOW = 2_000_000_000_000;
const PROJECT = "D:/workspace/demo";

function session(): Session {
  return {
    id: "session-1",
    path: PROJECT,
    name: "Demo",
    createdAt: NOW - 1000,
    active: true,
    status: "completed",
    agentId: "codex",
  };
}

function attention(kind: AttentionItem["kind"], id: string): AttentionItem {
  return {
    id: `attention:${id}`,
    sourceEventId: id,
    sourceDedupeKey: id,
    sourceRevision: 1,
    projectPath: PROJECT,
    sessionId: "session-1",
    sessionName: "Demo",
    agentId: "codex",
    kind,
    disposition: "open",
    priority: kind === "permission" || kind === "input" ? 1 : kind === "failure" ? 2 : 3,
    title: id,
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
  };
}

describe("store persistence v3", () => {
  it("migrates v2 state while discarding runtime-only attention", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const persisted = JSON.stringify({
      version: 2,
      state: {
        projectSessions: { [PROJECT]: [session()] },
        projectAttentionItems: {
          [PROJECT]: [attention("permission", "permission"), attention("completion", "done")],
        },
        sessionEvents: [],
        recentProjects: [],
      },
    });
    const storage: StateStorage = {
      getItem: () => persisted,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };

    const store = createAppStore(storage);

    expect(store.getState().projectAttentionItems[PROJECT]).toHaveLength(1);
    expect(store.getState().projectAttentionItems[PROJECT][0].kind).toBe("completion");
    expect(store.getState().windowMode).toBe("launcher");
  });

  it("writes version 3 with only restart-safe attention data", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let persisted: string | null = null;
    const storage: StateStorage = {
      getItem: () => null,
      setItem: (_name, value) => {
        persisted = value;
      },
      removeItem: vi.fn(),
    };
    const store = createAppStore(storage);

    store.setState({
      projectSessions: { [PROJECT]: [session()] },
      projectAttentionItems: {
        [PROJECT]: [attention("input", "input"), attention("failure", "failure")],
      },
    });

    const parsed = JSON.parse(persisted!);
    expect(parsed.version).toBe(3);
    expect(parsed.state.projectAttentionItems[PROJECT]).toHaveLength(1);
    expect(parsed.state.projectAttentionItems[PROJECT][0].kind).toBe("failure");
  });
});
