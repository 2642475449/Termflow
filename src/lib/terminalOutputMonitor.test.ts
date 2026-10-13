import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalOutputMonitor } from "./terminalOutputMonitor";
import { createTerminalImeOutputGate } from "./terminalImeOutput";
import { createTerminalOutputFrameGate, writeTerminalOutputWithCursorRefresh } from "./terminalOutputFrames";
import { Terminal as XTerm } from "@xterm/xterm";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup() {
  const onSnapshot = vi.fn();
  const onPressureChange = vi.fn();
  const monitor = createTerminalOutputMonitor({
    onSnapshot, onPressureChange, now: Date.now, pendingCharLimit: 8,
  });
  const callbacks: Array<() => void> = [];
  const writer = vi.fn((_data: string, complete: () => void) => callbacks.push(complete));
  return { monitor, writer, callbacks, onSnapshot, onPressureChange };
}

describe("terminal output backlog", () => {
  it("counts output until xterm parses it, including out-of-order and duplicate completions", () => {
    const { monitor, writer, callbacks } = setup();
    monitor.write("中文🙂", writer);
    monitor.write("abc", writer);
    expect(monitor.snapshot()).toMatchObject({ pendingChars: 7, pendingWrites: 2 });
    callbacks[1]();
    callbacks[1]();
    expect(monitor.snapshot()).toMatchObject({ pendingChars: 4, parsedChars: 3, pendingWrites: 1 });
    callbacks[0]();
    expect(monitor.snapshot()).toMatchObject({ pendingChars: 0, parsedChars: 7, peakPendingChars: 7 });
    monitor.dispose();
  });

  it("reports character-volume pressure once and reports recovery after parsing completes", () => {
    const { monitor, writer, callbacks, onPressureChange } = setup();
    monitor.write("12345678", writer);
    vi.advanceTimersByTime(2000);
    expect(onPressureChange).toHaveBeenCalledTimes(1);
    expect(onPressureChange.mock.calls[0][0].overloaded).toBe(true);
    callbacks[0]();
    vi.advanceTimersByTime(1000);
    expect(onPressureChange).toHaveBeenCalledTimes(2);
    expect(onPressureChange.mock.calls[1][0]).toMatchObject({ overloaded: false, pendingChars: 0 });
    monitor.dispose();
  });

  it("detects a small write waiting too long without treating idle terminals as stalled", () => {
    const { monitor, writer, callbacks, onPressureChange } = setup();
    vi.advanceTimersByTime(2000);
    expect(onPressureChange).not.toHaveBeenCalled();
    monitor.write("x", writer);
    vi.advanceTimersByTime(1000);
    expect(monitor.snapshot()).toMatchObject({ oldestWriteMs: 1000, overloaded: true });
    callbacks[0]();
    expect(monitor.snapshot()).toMatchObject({ oldestWriteMs: 0, overloaded: false });
    monitor.dispose();
  });

  it("includes output held by synchronized frames and IME without changing its content", () => {
    const callbacks: Array<() => void> = [];
    const output: string[] = [];
    const monitor = createTerminalOutputMonitor({
      now: Date.now,
      onSnapshot: vi.fn(), onPressureChange: vi.fn(),
      bufferedChars: () => frame.getBufferedChars() + ime.getBufferedChars(),
    });
    const ime = createTerminalImeOutputGate((data) => monitor.write(data, (text, done) => {
      output.push(text);
      callbacks.push(done);
    }), (callback) => Number(setTimeout(callback, 0)), clearTimeout);
    const frame = createTerminalOutputFrameGate((data) => ime.write(data), { enabled: true });
    ime.compositionStart();
    frame.write("\x1b[?2026h中文");
    expect(monitor.snapshot().bufferedChars).toBeGreaterThan(0);
    frame.write("\x1b[?2026l");
    expect(output).toEqual([]);
    ime.compositionEnd();
    vi.advanceTimersByTime(1);
    expect(output.join("")).toBe("\x1b[?2026h中文\x1b[?2026l");
    callbacks[0]();
    expect(monitor.snapshot()).toMatchObject({ pendingChars: 0, bufferedChars: 0 });
    frame.dispose();
    ime.dispose();
    monitor.dispose();
  });

  it("removes failed writes from pending counts and keeps later writes usable", () => {
    const { monitor, writer, callbacks } = setup();
    expect(() => monitor.write("bad", () => { throw new Error("disposed"); })).toThrow("disposed");
    expect(monitor.snapshot().pendingChars).toBe(0);
    monitor.write("ok", writer);
    callbacks[0]();
    expect(monitor.snapshot().parsedChars).toBe(2);
    monitor.dispose();
  });

  it("records parsing even if the cursor refresh fails", () => {
    const { monitor } = setup();
    const terminal = {
      rows: 24,
      buffer: { active: { type: "normal", cursorY: 0, baseY: 0, viewportY: 0 } },
      write: (_data: string, done?: () => void) => done?.(),
      refresh: () => { throw new Error("lost context"); },
    };
    monitor.write("output", (data, done) => writeTerminalOutputWithCursorRefresh(terminal, data, () => true, done));
    expect(monitor.snapshot()).toMatchObject({ pendingChars: 0, parsedChars: 6 });
    monitor.dispose();
  });

  it("drains bursts through the real xterm parser without changing screen content", async () => {
    vi.useRealTimers();
    const terminal = new XTerm({ cols: 80, rows: 24, scrollback: 200 });
    const monitor = createTerminalOutputMonitor({ onSnapshot: vi.fn(), onPressureChange: vi.fn() });
    const chunks = Array.from({ length: 100 }, (_, index) => `${index}: 中文🙂\r\n`);
    try {
      for (const chunk of chunks) {
        monitor.write(chunk, (data, done) => terminal.write(data, done));
      }
      expect(monitor.snapshot().pendingWrites).toBe(100);
      await new Promise<void>((resolve) => terminal.write("", resolve));
      expect(monitor.snapshot()).toMatchObject({
        pendingChars: 0, pendingWrites: 0,
        receivedChars: chunks.join("").length, parsedChars: chunks.join("").length,
      });
      const lines = Array.from({ length: terminal.buffer.active.length }, (_, row) =>
        terminal.buffer.active.getLine(row)?.translateToString(true)).join("\n");
      expect(lines).toContain("0: 中文🙂");
      expect(lines).toContain("99: 中文🙂");
    } finally {
      monitor.dispose();
      terminal.dispose();
    }
  });

  it("cancels diagnostics timers and ignores late callbacks after disposal", () => {
    const { monitor, writer, callbacks, onSnapshot } = setup();
    monitor.write("pending", writer);
    monitor.dispose();
    callbacks[0]();
    monitor.write("ignored", writer);
    vi.advanceTimersByTime(2000);
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(writer).toHaveBeenCalledTimes(1);
    expect(monitor.snapshot()).toMatchObject({ pendingChars: 0, parsedChars: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
