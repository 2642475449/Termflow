import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Terminal as XTerm } from "@xterm/xterm";
import type { Session } from "@/types";
import { canRestoreTerminalInputCursor, createTerminalAgentInterrupt, parseTerminalProgramStatus } from "./terminalAgentInterrupt";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(agentId: Session["agentId"] = "claude") {
  let session: Session = {
    id: "session", name: "task", path: "project", createdAt: 1, active: true,
    agentId, status: "running", statusRevision: 3, statusUpdatedAt: 1,
    checkpointActiveTurnId: "turn-a",
  };
  let screen = [{ row: 5, text: "prompt" }];
  const confirm = vi.fn();
  const tracker = createTerminalAgentInterrupt({
    getSession: () => session, getScreen: () => screen, confirm,
  });
  const idle = () => tracker.observeProgramStatus(`state=idle:app=${agentId === "codex" ? "codex" : "claude-code"}`);
  return {
    tracker, confirm, idle,
    update: (updates: Partial<Session>) => { session = { ...session, ...updates }; },
    screen: (text: string, row = 5) => { screen = [{ row, text }]; },
  };
}

it("does not mark Escape or silence alone as a successful interruption", () => {
  const { tracker, confirm } = setup();
  tracker.prepareInput("\x1b")(true);
  vi.runAllTimers();
  expect(confirm).not.toHaveBeenCalled();
});

it("repairs the prompt caret after interruption but leaves permission and question overlays alone", () => {
  const session: Session = {
    id: "session", name: "task", path: "project", createdAt: 1,
    agentId: "claude", active: true, status: "waiting", checkpointActiveTurnId: "turn-a",
  };
  expect(canRestoreTerminalInputCursor({ ...session, lastEventType: "interrupted" })).toBe(true);
  expect(canRestoreTerminalInputCursor({ ...session, status: "completed" })).toBe(true);
  for (const lastEventType of ["permission_request", "waiting_input", undefined]) {
    expect(canRestoreTerminalInputCursor({ ...session, lastEventType })).toBe(false);
  }
  expect(canRestoreTerminalInputCursor({ ...session, status: "running" })).toBe(false);
  expect(canRestoreTerminalInputCursor({ ...session, status: "completed", active: false })).toBe(false);
  expect(canRestoreTerminalInputCursor({ ...session, status: "completed", agentId: "antigravity" })).toBe(false);
});

it("waits for the PTY acknowledgement even when idle evidence arrives first", () => {
  const { tracker, confirm, idle } = setup();
  const acknowledge = tracker.prepareInput("\x1b");
  idle();
  vi.advanceTimersByTime(100);
  expect(confirm).not.toHaveBeenCalled();
  acknowledge(true);
  vi.advanceTimersByTime(80);
  expect(confirm).toHaveBeenCalledOnce();
});

it("does not change status when input could not be delivered", () => {
  const { tracker, confirm, idle } = setup();
  const acknowledge = tracker.prepareInput("\x1b");
  idle();
  acknowledge(false);
  vi.runAllTimers();
  expect(confirm).not.toHaveBeenCalled();
});

it("keeps a menu-closing Escape running when native activity stays busy", () => {
  const { tracker, confirm, idle } = setup();
  tracker.prepareInput("\x1b")(true);
  idle();
  tracker.observeProgramStatus("state=working:app=claude-code");
  vi.runAllTimers();
  expect(confirm).not.toHaveBeenCalled();
});

it.each([
  { statusRevision: 4 }, { status: "completed" as const }, { status: "waiting" as const },
  { checkpointActiveTurnId: "turn-b" }, { active: false }, { agentSessionId: "new-session" },
  { statusUpdatedAt: 10 }, { archived: true },
])("rejects old interruption evidence after the session changes: %j", (updates) => {
  const { tracker, confirm, idle, update } = setup();
  tracker.prepareInput("\x1b")(true);
  idle();
  update(updates);
  vi.runAllTimers();
  expect(confirm).not.toHaveBeenCalled();
});

it("invalidates an in-flight reconciliation as soon as the next Enter is sent", () => {
  const { tracker, confirm, idle } = setup();
  tracker.prepareInput("\x1b")(true);
  idle();
  vi.advanceTimersByTime(80);
  const baseline = confirm.mock.calls[0][0];
  expect(tracker.isCurrent(baseline)).toBe(true);
  tracker.prepareInput("\r");
  expect(tracker.isCurrent(baseline)).toBe(false);
});

it("uses native Claude title transitions when activity reports are absent", () => {
  const { tracker, confirm } = setup();
  tracker.observeTitle("⠋ Working");
  tracker.prepareInput("\x1b")(true);
  tracker.observeTitle("✳ Project");
  vi.advanceTimersByTime(80);
  expect(confirm).toHaveBeenCalledOnce();
});

it("does not mistake an old idle title or ordinary title words for a transition", () => {
  const { tracker, confirm } = setup();
  tracker.prepareInput("\x1b")(true);
  tracker.observeTitle("✳ Project");
  tracker.observeTitle("done fixing idle timeout");
  vi.runAllTimers();
  expect(confirm).not.toHaveBeenCalled();
});

it("gives native activity priority over title redraws", () => {
  const { tracker, confirm } = setup();
  tracker.observeTitle("⠋ Working");
  tracker.observeProgramStatus("state=working:app=claude-code");
  tracker.prepareInput("\x1b")(true);
  tracker.observeTitle("✳ Project");
  vi.runAllTimers();
  expect(confirm).not.toHaveBeenCalled();
});

it("correlates Antigravity Escape with its idle title", () => {
  const { tracker, confirm } = setup("antigravity");
  tracker.observeTitle("✦ Working");
  tracker.prepareInput("\x1b")(true);
  tracker.observeTitle("◇ Project");
  vi.advanceTimersByTime(80);
  expect(confirm).toHaveBeenCalledOnce();
});

it("requires two same-turn Escapes for OpenCode and rejects an expired first Escape", () => {
  const { tracker, confirm, screen } = setup("opencode");
  tracker.prepareInput("\x1b")(true);
  screen("Conversation interrupted");
  tracker.observeScreen();
  vi.advanceTimersByTime(2_001);
  tracker.prepareInput("\x1b")(true);
  vi.advanceTimersByTime(80);
  expect(confirm).not.toHaveBeenCalled();
});

it("ignores cancellation text already on screen and accepts a newly rendered Codex cancellation", () => {
  const { tracker, confirm, screen } = setup("codex");
  const message = "■ Conversation interrupted - tell the model what to do differently.";
  screen(message);
  tracker.prepareInput("\x1b")(true);
  tracker.observeScreen();
  vi.advanceTimersByTime(80);
  expect(confirm).not.toHaveBeenCalled();
  screen(message, 6);
  tracker.observeScreen();
  vi.advanceTimersByTime(80);
  expect(confirm).not.toHaveBeenCalled();
  screen("prompt");
  tracker.prepareInput("\x1b")(true);
  screen(message, 7);
  tracker.observeScreen();
  vi.advanceTimersByTime(80);
  expect(confirm).toHaveBeenCalledOnce();
});

it("does not let cancellation prose override an agent's native activity", () => {
  const { tracker, confirm, screen } = setup("codex");
  tracker.observeProgramStatus("state=working:app=codex");
  tracker.prepareInput("\x1b")(true);
  screen("■ Conversation interrupted - quoted text");
  tracker.observeScreen();
  vi.runAllTimers();
  expect(confirm).not.toHaveBeenCalled();
});

it("ignores Codex Ctrl+C, navigation, paste and released Kitty keys", () => {
  const { tracker, confirm, idle } = setup("codex");
  for (const input of ["\x03", "\x1b[A", "\x1b[200~\x1b\x1b[201~", "\x1b[27;1:3u"]) {
    tracker.prepareInput(input)(true);
    idle();
    vi.advanceTimersByTime(100);
  }
  expect(confirm).not.toHaveBeenCalled();
});

it("expires evidence and disposes timers without changing status", () => {
  const { tracker, confirm, idle } = setup();
  tracker.prepareInput("\x1b")(true);
  vi.advanceTimersByTime(2_001);
  idle();
  tracker.prepareInput("\x03")(true);
  idle();
  tracker.dispose();
  vi.runAllTimers();
  expect(confirm).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("parses only root activity from the expected CLI", () => {
  expect(parseTerminalProgramStatus("state=done:app=claude-code", "claude")).toBe("idle");
  expect(parseTerminalProgramStatus("state=working:app=codex", "codex")).toBe("working");
  for (const record of ["?", "state=done:app=codex", "state=idle:app=claude-code:parent=root", "state=waiting:app=claude-code"]) {
    expect(parseTerminalProgramStatus(record, "claude")).toBeNull();
  }
});

it("reads root activity through split OSC records without using child-idle reports", async () => {
  vi.useRealTimers();
  const terminal = new XTerm({ rows: 6, cols: 100 });
  const { tracker, confirm } = setup();
  const listener = terminal.parser.registerOscHandler(7501, (data) => {
    tracker.observeProgramStatus(data);
    return true;
  });
  const record = async (data: string) => {
    for (const char of `\x1b]7501;${data}\x1b\\`) terminal.write(char);
    await new Promise<void>((resolve) => terminal.write("", resolve));
  };
  try {
    await record("state=working:app=claude-code");
    tracker.prepareInput("\x1b")(true);
    await record("state=idle:app=claude-code:parent=root:id=child");
    expect(confirm).not.toHaveBeenCalled();
    await record("state=idle:app=claude-code");
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  } finally { listener.dispose(); tracker.dispose(); terminal.dispose(); }
});

it("recognizes a packetized cancellation through the real xterm parser", async () => {
  vi.useRealTimers();
  const terminal = new XTerm({ rows: 6, cols: 100 });
  const { tracker, confirm, screen } = setup("codex");
  const listener = terminal.onWriteParsed(() => {
    screen(terminal.buffer.active.getLine(0)?.translateToString(true) ?? "", 0);
    tracker.observeScreen();
  });
  try {
    tracker.prepareInput("\x1b")(true);
    for (const char of "\x1b[31m■ Conversation interrupted - tell the model what to do differently.\x1b[0m") {
      terminal.write(char);
    }
    await new Promise<void>((resolve) => terminal.write("", resolve));
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  } finally { listener.dispose(); tracker.dispose(); terminal.dispose(); }
});
