import { describe, expect, it, vi } from "vitest";
import { createTerminalRenderingPool } from "./terminalRendering";

function resource(webgl = true) {
  return {
    attachWebgl: vi.fn(() => webgl),
    disposeWebgl: vi.fn(),
    setCursorBlink: vi.fn(),
    cursorBlink: true,
    blur: vi.fn(),
    refresh: vi.fn(),
  };
}

describe("terminal rendering resources", () => {
  it("does not allocate WebGL for an initially hidden terminal", () => {
    const target = resource();
    const terminal = createTerminalRenderingPool().register(target);
    terminal.setVisible(false);
    expect(target.attachWebgl).not.toHaveBeenCalled();
    expect(target.setCursorBlink).toHaveBeenLastCalledWith(false);
    terminal.setVisible(true);
    expect(target.attachWebgl).toHaveBeenCalledTimes(1);
    expect(target.refresh).toHaveBeenCalledTimes(1);
    expect(target.setCursorBlink).toHaveBeenLastCalledWith(true);
  });

  it("retains recent hidden contexts and ignores duplicate visibility notifications", () => {
    const target = resource();
    const terminal = createTerminalRenderingPool().register(target);
    terminal.setVisible(true);
    terminal.setVisible(false);
    terminal.setVisible(false);
    terminal.setVisible(true);
    terminal.setVisible(true);
    expect(target.blur).toHaveBeenCalledTimes(1);
    expect(target.attachWebgl).toHaveBeenCalledTimes(1);
    expect(target.disposeWebgl).not.toHaveBeenCalled();
    expect(target.refresh).toHaveBeenCalledTimes(2);
  });

  it("evicts the least recently hidden context and recreates it on reveal", () => {
    const pool = createTerminalRenderingPool(1);
    const a = resource();
    const b = resource();
    const first = pool.register(a);
    const second = pool.register(b);
    first.setVisible(true);
    second.setVisible(true);
    first.setVisible(false);
    second.setVisible(false);
    expect(a.disposeWebgl).toHaveBeenCalledTimes(1);
    expect(b.disposeWebgl).not.toHaveBeenCalled();
    first.setVisible(true);
    expect(a.attachWebgl).toHaveBeenCalledTimes(2);
    second.setVisible(true);
    expect(b.attachWebgl).toHaveBeenCalledTimes(1);
  });

  it("updates recency after a terminal is revealed and hidden again", () => {
    const pool = createTerminalRenderingPool(2);
    const targets = [resource(), resource(), resource()];
    const terminals = targets.map((target) => pool.register(target));
    terminals.forEach((terminal) => terminal.setVisible(true));
    terminals[0].setVisible(false);
    terminals[1].setVisible(false);
    terminals[0].setVisible(true);
    terminals[0].setVisible(false);
    terminals[2].setVisible(false);
    expect(targets[1].disposeWebgl).toHaveBeenCalledTimes(1);
    expect(targets[0].disposeWebgl).not.toHaveBeenCalled();
  });

  it("does not count standard-rendered or failed WebGL terminals against the budget", () => {
    const pool = createTerminalRenderingPool(1);
    const gpu = resource();
    const first = pool.register(gpu);
    first.setVisible(true);
    first.setVisible(false);
    const standard = pool.register(resource(false));
    standard.setVisible(true);
    standard.setVisible(false);
    expect(gpu.disposeWebgl).not.toHaveBeenCalled();
  });

  it("clears lost contexts from retention and never changes a disabled cursor preference", () => {
    const target = { ...resource(), cursorBlink: false };
    const terminal = createTerminalRenderingPool().register(target);
    terminal.setVisible(true);
    terminal.setVisible(false);
    terminal.contextLost();
    terminal.contextLost();
    expect(target.disposeWebgl).toHaveBeenCalledTimes(1);
    terminal.setVisible(true);
    expect(target.attachWebgl).toHaveBeenCalledTimes(2);
    expect(target.setCursorBlink.mock.calls.every(([enabled]) => !enabled)).toBe(true);
  });

  it("unregisters disposed terminals without evicting other retained resources", () => {
    const pool = createTerminalRenderingPool(1);
    const target = resource();
    const terminal = pool.register(target);
    terminal.setVisible(true);
    terminal.setVisible(false);
    terminal.dispose();
    terminal.dispose();
    terminal.setVisible(true);
    expect(target.disposeWebgl).toHaveBeenCalledTimes(1);
    expect(target.attachWebgl).toHaveBeenCalledTimes(1);
    const other = resource();
    const second = pool.register(other);
    second.setVisible(true);
    second.setVisible(false);
    expect(other.disposeWebgl).not.toHaveBeenCalled();
  });

  it("can release all hidden contexts with a zero retention budget", () => {
    const target = resource();
    const terminal = createTerminalRenderingPool(0).register(target);
    terminal.setVisible(true);
    terminal.setVisible(false);
    expect(target.disposeWebgl).toHaveBeenCalledTimes(1);
  });
});
