import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXPLORER_REVEAL_PATH_EVENT,
  revealExplorerPath,
  takePendingExplorerRevealPath,
} from "./explorer";

describe("explorer reveal path", () => {
  afterEach(() => {
    takePendingExplorerRevealPath();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps a reveal request pending when the explorer listener mounts late", () => {
    vi.useFakeTimers();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      dispatchEvent,
    });
    vi.stubGlobal(
      "CustomEvent",
      class<T> {
        type: string;
        detail: T;

        constructor(type: string, init: { detail: T }) {
          this.type = type;
          this.detail = init.detail;
        }
      },
    );

    revealExplorerPath("E:/project/src/App.tsx", "file");
    vi.runAllTimers();

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent.mock.calls[0][0]).toMatchObject({
      type: EXPLORER_REVEAL_PATH_EVENT,
      detail: { path: "E:/project/src/App.tsx", kind: "file" },
    });
    expect(takePendingExplorerRevealPath()).toEqual({
      path: "E:/project/src/App.tsx",
      kind: "file",
    });
  });
});
