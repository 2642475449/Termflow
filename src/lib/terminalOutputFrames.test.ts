import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal as XTerm } from "@xterm/xterm";
import { createTerminalImeOutputGate } from "./terminalImeOutput";
import { createTerminalOutputFrameGate, writeTerminalOutputWithCursorRefresh } from "./terminalOutputFrames";

const START = "\x1b[?2026h";
const END = "\x1b[?2026l";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const PLACE = "\x1b[4;8H";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(shouldHideCursor = false) {
  const write = vi.fn<(data: string) => void>();
  const gate = createTerminalOutputFrameGate((data) => write(data), {
    enabled: true,
    shouldHideCursor: () => shouldHideCursor,
  });
  return { write, gate, output: () => write.mock.calls.map(([data]) => data).join("") };
}

describe("terminal synchronized output frames", () => {
  it("passes ordinary output through without a timer", () => {
    const { gate, write } = setup();
    gate.write("hello\r\n");
    expect(write).toHaveBeenCalledExactlyOnceWith("hello\r\n");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("buffers a split frame until its closing marker", () => {
    const { gate, write } = setup();
    gate.write(`${START}first`);
    gate.write("second");
    expect(write).not.toHaveBeenCalled();
    gate.write(END);
    expect(write).toHaveBeenCalledExactlyOnceWith(`${START}firstsecond${END}`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recognizes frame and cursor markers at every possible packet boundary", () => {
    const frame = `${START}${HIDE}prompt${SHOW}${PLACE}${END}`;
    for (let split = 1; split < frame.length; split++) {
      const { gate, output } = setup();
      gate.write(frame.slice(0, split));
      gate.write(frame.slice(split));
      expect(output()).toBe(`${START}${HIDE}prompt${PLACE}${END}${SHOW}`);
      gate.dispose();
    }
  });

  it("handles single-character delivery without leaking partial CSI", () => {
    const { gate, output } = setup(true);
    const frame = `${START}${HIDE}中文${SHOW}${PLACE}${END}`;
    for (const char of frame) gate.write(char);
    expect(output()).toBe(`${START}${HIDE}中文${PLACE}${END}${SHOW}${HIDE}`);
  });

  it("keeps a completed frame ahead of the next open frame", () => {
    const { gate, output } = setup();
    gate.write(`prefix${START}one${END}${START}two`);
    expect(output()).toBe(`prefix${START}one${END}`);
    gate.write(END);
    expect(output()).toBe(`prefix${START}one${END}${START}two${END}`);
  });

  it("supports combined private modes and C1 CSI", () => {
    const { gate, write } = setup();
    gate.write("\x9b?2026;25hbody");
    expect(write).not.toHaveBeenCalled();
    gate.write("\x9b?2026l");
    expect(write).toHaveBeenCalledExactlyOnceWith("\x9b?2026;25hbody\x9b?2026l");
  });

  it("waits briefly for final cursor placement after a split frame close", () => {
    const { gate, write } = setup();
    gate.markUserInput();
    gate.write(`${START}${HIDE}prompt${SHOW}${END}`);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5);
    gate.write(`${HIDE}${PLACE}${SHOW}`);
    expect(write).toHaveBeenCalledExactlyOnceWith(`${START}${HIDE}prompt${END}${HIDE}${PLACE}${SHOW}`);
    vi.advanceTimersByTime(11);
    expect(write).toHaveBeenCalledExactlyOnceWith(`${START}${HIDE}prompt${END}${HIDE}${PLACE}${SHOW}`);
  });

  it("does not extend cursor settlement on every new chunk", () => {
    const { gate, write } = setup();
    gate.write(`${START}${HIDE}prompt${SHOW}${END}`);
    vi.advanceTimersByTime(10);
    gate.write("tail");
    vi.advanceTimersByTime(6);
    expect(write).toHaveBeenCalledExactlyOnceWith(`${START}${HIDE}prompt${END}tail${SHOW}`);
  });

  it("releases a missing cursor restore within 16ms", () => {
    const { gate, write } = setup();
    gate.write(`${START}${HIDE}prompt${SHOW}${END}`);
    vi.advanceTimersByTime(15);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledExactlyOnceWith(`${START}${HIDE}prompt${END}${SHOW}`);
  });

  it("drops transient cursor shows followed by hides in a frame", () => {
    const { gate, output } = setup();
    gate.write(`${START}${SHOW}one${HIDE}two${SHOW}${PLACE}${END}`);
    expect(output()).toBe(`${START}one${HIDE}two${PLACE}${END}${SHOW}`);
  });

  it("leaves cursor protocol outside synchronized frames untouched", () => {
    const { gate, output } = setup();
    const ordinary = `${SHOW}one${HIDE}${PLACE}${SHOW}`;
    gate.write(ordinary);
    expect(output()).toBe(ordinary);
  });

  it("ignores embedded markers and cursor controls in OSC and DCS strings", () => {
    const { gate, output } = setup();
    const osc = `\x1b]0;title${START}${SHOW}\x07`;
    const dcs = `\x1bPdata${END}${HIDE}\x1b\\`;
    gate.write(`${osc.slice(0, 9)}`);
    gate.write(`${osc.slice(9)}${START}${dcs.slice(0, -1)}`);
    gate.write(`${dcs.slice(-1)}body${END}`);
    expect(output()).toBe(`${osc}${START}${dcs}body${END}`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never injects a cursor command inside a split string sequence", () => {
    const { gate, output } = setup(true);
    gate.write("\x1b]0;title");
    expect(output()).toBe("\x1b]0;title");
    gate.write("\x07");
    expect(output()).toBe(`\x1b]0;title\x07${HIDE}`);
  });

  it("keeps running-cursor suppression from aborting a split CSI", () => {
    const { gate, output } = setup(true);
    gate.write("\x1b[4;");
    expect(output()).toBe("");
    gate.write("8H");
    expect(output()).toBe(`${PLACE}${HIDE}`);
  });

  it("releases an incomplete frame at a fixed deadline", () => {
    const { gate, output } = setup();
    gate.write(`${START}first`);
    vi.advanceTimersByTime(200);
    gate.write(`${START}second`);
    vi.advanceTimersByTime(50);
    expect(output()).toBe(`${START}first${START}second${END}`);
    gate.write(`tail${END}`);
    expect(output()).toBe(`${START}first${START}second${END}tail${END}`);
  });

  it("bounds an input-triggered open frame to 32ms", () => {
    const { gate, write } = setup();
    gate.markUserInput();
    gate.write(`${START}typing`);
    vi.advanceTimersByTime(31);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledExactlyOnceWith(`${START}typing${END}`);
  });

  it("shortens an already open frame when the user starts typing", () => {
    const { gate, write } = setup();
    gate.write(`${START}body`);
    vi.advanceTimersByTime(100);
    gate.markUserInput();
    vi.advanceTimersByTime(32);
    expect(write).toHaveBeenCalledExactlyOnceWith(`${START}body${END}`);
  });

  it("caps frame memory without dropping terminal output", () => {
    const { gate, output } = setup();
    const body = "x".repeat(256 * 1024);
    gate.write(`${START}${body}`);
    expect(output()).toBe(`${START}${body}${END}`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defers cursor visibility changes until a buffered frame completes", () => {
    const { gate, write } = setup();
    gate.write(`${START}body`);
    gate.syncCursorVisibility(false);
    expect(write).not.toHaveBeenCalled();
    gate.write(END);
    expect(write).toHaveBeenCalledExactlyOnceWith(`${START}body${END}${SHOW}`);
  });

  it("flushes remaining output and releases sync mode before process exit", () => {
    const { gate, output } = setup();
    gate.write(`${START}body\x1b[?2026`);
    gate.flush();
    expect(output()).toBe(`${START}body\x1b[?2026\x18${END}`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels all pending work when the terminal is disposed", () => {
    const { gate, write } = setup();
    gate.write(`${START}body`);
    gate.dispose();
    vi.runAllTimers();
    gate.markUserInput();
    gate.write(END);
    gate.syncCursorVisibility(false);
    gate.flush();
    expect(write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an unfinished OSC before flushing an open frame on exit", () => {
    const { gate, output } = setup();
    gate.write(`${START}\x1b]0;unfinished title`);
    gate.flush();
    expect(output()).toBe(`${START}\x1b]0;unfinished title\x18${END}`);
  });

  it("does not inject controls into a streamed oversized CSI", () => {
    const { gate, output } = setup(true);
    const data = `\x1b[${"0;".repeat(128 * 1024)}1m`;
    gate.write(data);
    expect(output()).toBe(`${data}${HIDE}`);
  });

  it("preserves the existing stream behavior when protection is disabled", () => {
    const write = vi.fn();
    const gate = createTerminalOutputFrameGate((data) => write(data), { enabled: false });
    gate.write(`${START}body`);
    expect(write).toHaveBeenCalledExactlyOnceWith(`${START}body`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not bypass IME composition when a frame times out", () => {
    const write = vi.fn();
    const ime = createTerminalImeOutputGate(write, (callback) => Number(setTimeout(callback, 0)), clearTimeout);
    const gate = createTerminalOutputFrameGate(ime.write, { enabled: true });
    ime.compositionStart();
    gate.write(`${START}body`);
    vi.advanceTimersByTime(250);
    expect(write).not.toHaveBeenCalled();
    ime.compositionEnd();
    vi.runAllTimers();
    expect(write).toHaveBeenCalledExactlyOnceWith(`${START}body${END}`);
  });

  it("replays packetized frames through the real xterm parser with the same screen and final cursor", async () => {
    vi.useRealTimers();
    const original = `${START}${HIDE}\x1b[2J\x1b[Hhello${SHOW}${PLACE}${END}`;
    const baseline = new XTerm({ cols: 40, rows: 10 });
    const protectedTerminal = new XTerm({ cols: 40, rows: 10 });
    const gate = createTerminalOutputFrameGate((data) => protectedTerminal.write(data), { enabled: true });
    try {
      await new Promise<void>((resolve) => baseline.write(original, resolve));
      for (const char of original) gate.write(char);
      await new Promise<void>((resolve) => protectedTerminal.write("", resolve));
      for (let row = 0; row < 10; row++) {
        expect(protectedTerminal.buffer.active.getLine(row)?.translateToString()).toBe(
          baseline.buffer.active.getLine(row)?.translateToString(),
        );
      }
      expect(protectedTerminal.buffer.active.cursorX).toBe(7);
      expect(protectedTerminal.buffer.active.cursorY).toBe(3);
      expect(protectedTerminal.modes.synchronizedOutputMode).toBe(false);
    } finally {
      gate.dispose();
      baseline.dispose();
      protectedTerminal.dispose();
    }
  });
});

describe("terminal frame cursor refresh", () => {
  function setupTerminal() {
    const active = { type: "normal", cursorY: 2, baseY: 10, viewportY: 10 };
    let parsed: (() => void) | undefined;
    const terminal = {
      rows: 20,
      buffer: { active },
      write: vi.fn((_data: string, callback?: () => void) => { parsed = callback; }),
      refresh: vi.fn<(start: number, end: number) => void>(),
    };
    return { terminal, parsed: () => parsed?.() };
  }

  it("refreshes the old and final cursor rows only after parsing", () => {
    const { terminal, parsed } = setupTerminal();
    writeTerminalOutputWithCursorRefresh(terminal, "frame", () => true);
    expect(terminal.refresh).not.toHaveBeenCalled();
    terminal.buffer.active.cursorY = 5;
    parsed();
    expect(terminal.refresh).toHaveBeenCalledExactlyOnceWith(2, 5);
  });

  it("refreshes the whole viewport when a frame scrolls or changes buffers", () => {
    const { terminal, parsed } = setupTerminal();
    writeTerminalOutputWithCursorRefresh(terminal, "frame", () => true);
    terminal.buffer.active.baseY++;
    parsed();
    expect(terminal.refresh).toHaveBeenCalledExactlyOnceWith(0, 19);
  });

  it("keeps offscreen cursor repairs from repainting a scrolled-back viewport", () => {
    const { terminal, parsed } = setupTerminal();
    terminal.buffer.active.viewportY = 0;
    terminal.buffer.active.cursorY = 15;
    writeTerminalOutputWithCursorRefresh(terminal, "frame", () => true);
    parsed();
    expect(terminal.refresh).not.toHaveBeenCalled();
  });

  it("does not refresh a terminal that became hidden or disposed before parsing", () => {
    const { terminal, parsed } = setupTerminal();
    writeTerminalOutputWithCursorRefresh(terminal, "frame", () => false);
    parsed();
    expect(terminal.refresh).not.toHaveBeenCalled();
  });

  it("contains refresh failures so xterm can parse the following writes", () => {
    const { terminal, parsed } = setupTerminal();
    terminal.refresh.mockImplementation(() => { throw new Error("disposed"); });
    writeTerminalOutputWithCursorRefresh(terminal, "frame", () => true);
    expect(parsed).not.toThrow();
  });
});
