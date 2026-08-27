import { describe, expect, it, vi } from "vitest";
import { createTerminalImeOutputGate } from "./terminalImeOutput";

describe("terminal IME output gate", () => {
  it("holds PTY output until after xterm can commit an IME composition", () => {
    const write = vi.fn();
    const scheduled: Array<() => void> = [];
    const gate = createTerminalImeOutputGate(
      write,
      (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      () => {},
    );

    gate.compositionStart();
    gate.write("background output");
    gate.compositionEnd();

    expect(write).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    expect(write).toHaveBeenCalledWith("background output");
  });

  it("also holds output that arrives during composition settlement", () => {
    const write = vi.fn();
    const scheduled: Array<() => void> = [];
    const gate = createTerminalImeOutputGate(write, (callback) => {
      scheduled.push(callback);
      return scheduled.length;
    }, () => {});

    gate.compositionStart();
    gate.compositionEnd();
    gate.write("reply");
    scheduled[0]();

    expect(write).toHaveBeenCalledWith("reply");
  });
});
