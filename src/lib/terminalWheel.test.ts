import { describe, expect, it, vi } from "vitest";
import { createTerminalWheelHandler, type TerminalWheelContext } from "./terminalWheel";

const context: TerminalWheelContext = {
  agentId: "pi", bufferType: "alternate", mouseTrackingMode: "none", rows: 20, cols: 80,
  screen: { left: 10, top: 20, width: 800, height: 400 },
};

function wheel(deltaY: number, deltaMode = 0) {
  return {
    deltaY, deltaMode, clientX: 35, clientY: 65,
    shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
  };
}

describe("createTerminalWheelHandler", () => {
  it.each([[-120, "\x1b[<64;3;3M"], [120, "\x1b[<65;3;3M"]])(
    "sends PI a wheel report instead of history navigation for delta %s", (delta, report) => {
      const send = vi.fn();
      const handler = createTerminalWheelHandler(() => context, send);
      const event = wheel(delta);
      expect(handler(event)).toBe(false);
      expect(send).toHaveBeenCalledExactlyOnceWith(report);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
    },
  );

  it.each(["vt200", "drag", "any"] as const)("preserves native mouse wheel reporting for %s", (mode) => {
    const send = vi.fn();
    const event = wheel(-120);
    expect(createTerminalWheelHandler(() => ({ ...context, mouseTrackingMode: mode }), send)(event)).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("uses the fallback for x10 tracking, which cannot report wheel events", () => {
    const send = vi.fn();
    expect(createTerminalWheelHandler(() => ({ ...context, mouseTrackingMode: "x10" }), send)(wheel(-120))).toBe(false);
    expect(send).toHaveBeenCalledExactlyOnceWith("\x1b[<64;3;3M");
  });

  it.each([
    { ...context, agentId: "claude" },
    { ...context, agentId: "powershell" },
    { ...context, bufferType: "normal" as const },
    null,
  ])("preserves scrollback and other terminal applications", (state) => {
    const send = vi.fn();
    const event = wheel(-120);
    expect(createTerminalWheelHandler(() => state, send)(event)).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("accumulates small trackpad deltas and resets when scrolling reverses", () => {
    const send = vi.fn();
    const handler = createTerminalWheelHandler(() => context, send);
    handler(wheel(-8));
    handler(wheel(-8));
    expect(send).not.toHaveBeenCalled();
    handler(wheel(12));
    expect(send).not.toHaveBeenCalled();
    handler(wheel(8));
    expect(send).toHaveBeenCalledExactlyOnceWith("\x1b[<65;3;3M");
  });

  it.each([1, 2])("supports deltaMode %s without multiplying page jumps", (mode) => {
    const send = vi.fn();
    createTerminalWheelHandler(() => context, send)(wheel(-3, mode));
    expect(send).toHaveBeenCalledExactlyOnceWith("\x1b[<64;3;3M");
  });

  it("preserves modifiers and clamps coordinates to the terminal grid", () => {
    const send = vi.fn();
    createTerminalWheelHandler(() => context, send)({ ...wheel(120), shiftKey: true, altKey: true, clientX: -10, clientY: 999 });
    expect(send).toHaveBeenCalledExactlyOnceWith("\x1b[<77;1;20M");
  });

  it("does not intercept zoom gestures, horizontal scrolling or hidden terminals", () => {
    const send = vi.fn();
    const handler = createTerminalWheelHandler(() => context, send);
    expect(handler({ ...wheel(-120), ctrlKey: true })).toBe(true);
    expect(handler({ ...wheel(-120), metaKey: true })).toBe(true);
    expect(handler(wheel(0))).toBe(true);
    expect(createTerminalWheelHandler(() => ({ ...context, screen: { ...context.screen, height: 0 } }), send)(wheel(-120))).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
