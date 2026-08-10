import { describe, expect, it } from "vitest";
import { isSessionVisibleInWorkspace } from "./sessionVisibility";

function splitSnapshot() {
  return {
    activeSessionId: "session-right",
    layout: {
      root: {
        type: "split" as const,
        first: { type: "pane" as const, paneId: "left" },
        second: { type: "pane" as const, paneId: "right" },
      },
    },
    panesById: {
      left: { activeTabId: "tab-left" as string | null },
      right: { activeTabId: "tab-right" as string | null },
    },
    tabsById: {
      "tab-left": { kind: "session", resourceId: "session-left" },
      "tab-right": { kind: "session", resourceId: "session-right" },
      hidden: { kind: "session", resourceId: "session-hidden" },
    },
  };
}

describe("isSessionVisibleInWorkspace", () => {
  it("treats the active Session in every split Pane as visible", () => {
    const snapshot = splitSnapshot();
    expect(isSessionVisibleInWorkspace("session-left", snapshot)).toBe(true);
    expect(isSessionVisibleInWorkspace("session-right", snapshot)).toBe(true);
  });

  it("does not treat a covered Tab as visible", () => {
    expect(isSessionVisibleInWorkspace("session-hidden", splitSnapshot())).toBe(false);
  });

  it("falls back to activeSessionId while workspace entities are unavailable", () => {
    const snapshot = splitSnapshot();
    snapshot.panesById = {
      left: { activeTabId: null },
      right: { activeTabId: null },
    };
    expect(isSessionVisibleInWorkspace("session-right", snapshot)).toBe(true);
  });
});
