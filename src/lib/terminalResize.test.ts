import { describe, expect, it, vi } from "vitest";
import { createPtyResizeGate } from "./terminalResize";

describe("PTY resize gate", () => {
  it("does not resize again when session state changes but the grid is unchanged", () => {
    const resize = vi.fn();
    const requestResize = createPtyResizeGate(resize);

    expect(requestResize(40, 120)).toBe(true);
    expect(requestResize(40, 120)).toBe(false);
    expect(requestResize(40, 120)).toBe(false);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenLastCalledWith(40, 120);
  });

  it("forwards a resize when either grid dimension changes", () => {
    const resize = vi.fn();
    const requestResize = createPtyResizeGate(resize);

    requestResize(40, 120);
    requestResize(41, 120);
    requestResize(41, 121);

    expect(resize.mock.calls).toEqual([
      [40, 120],
      [41, 120],
      [41, 121],
    ]);
  });
});
