import { describe, expect, it } from "vitest";
import type { Session } from "@/types";
import {
  isEphemeralTerminalSession,
  isSessionTurnRunning,
  isSessionVisibleInHistory,
  toPersistedProjectSessions,
  toPersistedSession,
  withoutEphemeralTerminalSessions,
  withoutSessionHistoryExcludedSessions,
} from "./sessions";

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
