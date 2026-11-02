import { describe, expect, it } from "vitest";
import type { Session } from "@/types";
import { createAppStore } from "@/store";
import {
  isEphemeralTerminalSession,
  addTerminalSession,
  isSessionTurnRunning,
  isSessionVisibleInHistory,
  toPersistedProjectSessions,
  toPersistedSession,
  withoutEphemeralTerminalSessions,
  withoutSessionHistoryExcludedSessions,
} from "./sessions";

it.each(["right", "down"] as const)("opens an independent terminal to the %s of a single tab using store actions", (direction) => {
  const store = createAppStore();
  store.getState().setCurrentProject({ name: "Project", path: "D:/project" });
  store.getState().addSession(session({ id: "original", agentId: "cmd" }));
  const nextSession = session({ id: "split-terminal", agentId: "cmd", ephemeral: true, active: false, status: "starting" });

  expect(addTerminalSession(store.getState(), nextSession, { paneId: "main", tabId: "original", direction })).toBe(true);
  const state = store.getState();
  expect(state.panesById.main.tabIds).toEqual(["original"]);
  expect(state.panesById[state.activePaneId ?? ""].tabIds).toEqual(["split-terminal"]);
  expect(state.activePaneId).not.toBe("main");
  expect(state.focusedTabId).toBe("split-terminal");
  expect(state.sessions.find((item) => item.id === "original")?.active).toBe(true);
  expect(state.projectWorkspaces["D:/project"].layout.root).toMatchObject({
    type: "split", direction: direction === "right" ? "horizontal" : "vertical",
  });

  // 启动失败时移除新会话，原终端与布局仍然完整。
  state.removeSession("split-terminal");
  expect(store.getState().panesById.main.tabIds).toEqual(["original"]);
  expect(store.getState().projectWorkspaces["D:/project"].layout.root).toEqual({ type: "pane", paneId: "main" });
});

it("does not create a split terminal when its source tab or project has disappeared", () => {
  const store = createAppStore();
  store.getState().setCurrentProject({ name: "Project", path: "D:/project" });
  const target = { paneId: "main", tabId: "missing", direction: "right" as const };
  expect(addTerminalSession(store.getState(), session(), target)).toBe(false);
  expect(store.getState().sessions).toEqual([]);
  expect(addTerminalSession(store.getState(), session({ path: "D:/other" }))).toBe(false);
  expect(store.getState().sessions).toEqual([]);
});

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    path: "D:/project",
    name: "Session",
    createdAt: 1,
    active: true,
    ...overrides,
  };
}

describe("isEphemeralTerminalSession", () => {
  it("recognizes explicitly transient and shell-backed tabs", () => {
    expect(isEphemeralTerminalSession(session({ ephemeral: true }))).toBe(true);
    expect(isEphemeralTerminalSession(session({ agentId: "powershell" }))).toBe(true);
    expect(isEphemeralTerminalSession(session({ agentId: "cmd" }))).toBe(true);
  });

  it("recognizes legacy terminal quick commands without hiding agent prompts", () => {
    expect(isEphemeralTerminalSession(session({ id: "qc-123", hasPromptHistory: false }))).toBe(true);
    expect(isEphemeralTerminalSession(session({ id: "qc-123", hasPromptHistory: true }))).toBe(false);
  });

  it("keeps resumable agent sessions", () => {
    expect(isEphemeralTerminalSession(session({ agentId: "claude" }))).toBe(false);
    expect(isEphemeralTerminalSession(session({ agentId: "codex" }))).toBe(false);
  });

  it("keeps auxiliary tasks out of the main session history", () => {
    expect(isSessionVisibleInHistory(session({ agentId: "codex" }))).toBe(true);
    expect(isSessionVisibleInHistory(session({
      agentId: "codex",
      presentation: "auxiliary",
    }))).toBe(false);
    expect(isSessionVisibleInHistory(session({ ephemeral: true }))).toBe(false);
  });

  it("removes transient terminals from persisted project histories", () => {
    const resumable = session({ id: "agent", agentId: "codex" });
    const terminal = session({ id: "terminal", agentId: "powershell", ephemeral: true });
    expect(withoutEphemeralTerminalSessions({ "D:/project": [terminal, resumable] })).toEqual({
      "D:/project": [resumable],
    });
  });

  it("does not persist auxiliary tasks as resumable history", () => {
    const primary = session({ id: "primary", agentId: "codex" });
    const auxiliary = session({
      id: "side-task",
      agentId: "codex",
      presentation: "auxiliary",
    });
    expect(withoutSessionHistoryExcludedSessions({
      "D:/project": [auxiliary, primary],
    })).toEqual({ "D:/project": [primary] });
  });
});

describe("isSessionTurnRunning", () => {
  it("counts only starting and running turns", () => {
    expect(isSessionTurnRunning(session({ active: true, status: "starting" }))).toBe(true);
    expect(isSessionTurnRunning(session({ active: true, status: "running" }))).toBe(true);
  });

  it("does not treat an idle live PTY as a running turn", () => {
    expect(isSessionTurnRunning(session({ active: true, status: "waiting" }))).toBe(false);
    expect(isSessionTurnRunning(session({ active: true, status: "completed" }))).toBe(false);
    expect(isSessionTurnRunning(session({ active: true, status: "stopped" }))).toBe(false);
  });

  it("does not trust a stale running status without a live PTY", () => {
    expect(isSessionTurnRunning(session({ active: false, status: "starting" }))).toBe(false);
    expect(isSessionTurnRunning(session({ active: false, status: "running" }))).toBe(false);
  });
});

describe("persisted session history", () => {
  it("strips process-local activity from resumable sessions", () => {
    expect(toPersistedSession(session({ active: true, status: "running" }))).toMatchObject({
      active: false,
      status: "stopped",
    });
    expect(toPersistedSession(session({ active: true, status: "waiting" }))).toMatchObject({
      active: false,
      status: "waiting",
    });
  });

  it("excludes transient surfaces while sanitizing retained sessions", () => {
    const running = session({ id: "agent", agentId: "codex", status: "starting" });
    const terminal = session({ id: "terminal", agentId: "powershell", ephemeral: true });

    expect(toPersistedProjectSessions({ "D:/project": [terminal, running] })).toEqual({
      "D:/project": [{ ...running, active: false, status: "stopped" }],
    });
  });
});

it("excludes bottom-runner presentations from both history and persisted project snapshots", () => {
  const runner = session({ id: "runner", presentation: "bottom-runner" });
  expect(isSessionVisibleInHistory(runner)).toBe(false);
  expect(toPersistedProjectSessions({ A: [runner] })).toEqual({ A: [] });
});
