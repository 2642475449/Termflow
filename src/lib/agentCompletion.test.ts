import { describe, expect, it } from "vitest";
import type { Session } from "@/types";
import { createAppStore } from "@/store";
import { createDefaultWorkspace } from "@/store/utils/workspace";
import { getAgentCompletionUpdates } from "./agentCompletion";
import { collectTaskMonitorTabs } from "./taskMonitor";

const session: Session = {
  id: "codex-session", name: "Codex", path: "E:/project", createdAt: 100,
  agentId: "codex", active: true, status: "running",
  statusRevision: 7, statusUpdatedAt: 200,
};
const completion = {
  id: "complete-8", sessionId: session.id, projectPath: session.path,
  sessionName: session.name, source: "codex", eventType: "assistant_complete" as const,
  revision: 8, createdAt: 300, title: "", body: "", severity: "info" as const,
  requiresAttention: true, actionable: true,
};

describe("agent completion status recovery", () => {
  it("converges the store and task monitor when only the completion event arrives", () => {
    const store = createAppStore();
    store.setState({
      currentProject: { path: session.path, name: "project" },
      projectSessions: { [session.path]: [session] },
      projectWorkspaces: { [session.path]: createDefaultWorkspace() },
      sessions: [session],
    });
    expect(store.getState().pushSessionEvent(completion)).toBe("accepted");
    expect(store.getState().sessions[0].status).toBe("running");
    const updates = getAgentCompletionUpdates(store.getState().sessions[0], completion);
    expect(updates).not.toBeNull();
    store.getState().updateSession(session.id, updates!);
    expect(store.getState().sessions[0]).toMatchObject({
      status: "completed", statusRevision: 8, statusUpdatedAt: 300, active: true,
    });
    expect(collectTaskMonitorTabs(store.getState().sessions, {
      main: { id: "main", tabIds: [session.id] },
    }, {})[0].status).toBe("completed");
    expect(getAgentCompletionUpdates(store.getState().sessions[0], completion)).toBeNull();
  });

  it("does not overwrite a newer turn or a status already delivered at the same revision", () => {
    for (const statusRevision of [8, 9]) {
      expect(getAgentCompletionUpdates({ ...session, statusRevision }, completion)).toBeNull();
    }
  });

  it("rejects completion older than local input or the latest lifecycle event", () => {
    expect(getAgentCompletionUpdates({ ...session, statusUpdatedAt: 301 }, completion)).toBeNull();
    expect(getAgentCompletionUpdates({ ...session, lastEventAt: 301 }, completion)).toBeNull();
  });

  it("does not revive closed, archived, disconnected, or failed sessions", () => {
    for (const extra of [
      { active: false }, { archived: true }, { status: "stopped" as const },
      { status: "error" as const },
    ]) {
      expect(getAgentCompletionUpdates({ ...session, ...extra }, completion)).toBeNull();
    }
    expect(getAgentCompletionUpdates(undefined, completion)).toBeNull();
  });

  it("requires a matching provider, session, and versioned completion event", () => {
    for (const extra of [
      { source: "claude" }, { source: "runtime" }, { sessionId: "other" },
      { eventType: "terminal_command_complete" }, { revision: null },
      { revision: undefined }, { revision: NaN }, { revision: Infinity },
      { createdAt: NaN },
    ]) {
      expect(getAgentCompletionUpdates(session, { ...completion, ...extra })).toBeNull();
    }
  });
});
