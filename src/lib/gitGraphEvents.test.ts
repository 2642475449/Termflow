import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GIT_GRAPH_REFRESH_EVENT,
  refreshGitStateAndGraph,
  shouldReloadGitGraphOnExpand,
} from "./gitGraphEvents";

class CustomEventStub<T> {
  readonly detail: T | null;

  constructor(
    readonly type: string,
    eventInitDict?: CustomEventInit<T>,
  ) {
    this.detail = eventInitDict?.detail ?? null;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("refreshGitStateAndGraph", () => {
  it("refreshes Git state before dispatching the graph refresh event", async () => {
    const calls: string[] = [];
    const dispatchEvent = vi.fn((event: CustomEventStub<{ projectPath: string }>) => {
      calls.push(`graph:${event.detail?.projectPath}`);
      return true;
    });
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal("CustomEvent", CustomEventStub);

    await refreshGitStateAndGraph("D:/workspace/demo", async () => {
      calls.push("status");
    });

    expect(calls).toEqual(["status", "graph:D:/workspace/demo"]);
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent.mock.calls[0][0].type).toBe(GIT_GRAPH_REFRESH_EVENT);
  });

  it("still invalidates the graph if the status refresh fails", async () => {
    const dispatchEvent = vi.fn(() => true);
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal("CustomEvent", CustomEventStub);

    await expect(
      refreshGitStateAndGraph("D:/workspace/demo", async () => {
        throw new Error("status failed");
      }),
    ).rejects.toThrow("status failed");

    expect(dispatchEvent).toHaveBeenCalledOnce();
  });
});

describe("shouldReloadGitGraphOnExpand", () => {
  it("reloads an initialized graph when it changes from collapsed to expanded", () => {
    expect(shouldReloadGitGraphOnExpand(true, false, true)).toBe(true);
  });

  it("does not reload for initial render, collapse, or an uninitialized graph", () => {
    expect(shouldReloadGitGraphOnExpand(false, false, true)).toBe(false);
    expect(shouldReloadGitGraphOnExpand(false, true, true)).toBe(false);
    expect(shouldReloadGitGraphOnExpand(true, false, false)).toBe(false);
  });
});
