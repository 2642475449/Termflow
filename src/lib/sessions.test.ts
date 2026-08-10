import { describe, expect, it } from "vitest";
import type { Session } from "@/types";
import {
  isEphemeralTerminalSession,
  isSessionVisibleInHistory,
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
