import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/types";
import type { ProjectWorkspace } from "../types";
import {
  activateTabInWorkspace,
  closeTabInWorkspace,
  createDefaultWorkspace,
  normalizeWorkspace,
  openTabInWorkspace,
  reorderTabsInWorkspace,
  moveTabToPaneInWorkspace,
  splitTabInWorkspace,
  syncWorkspaceSnapshot,
} from "./workspace";

const MAIN_PANE_ID = "main";
const SETTINGS_ID = "__settings__";

function createSession(
  id: string,
  name: string,
  createdAt = 100,
  path = "D:/workspace/demo"
): Session {
  return {
    id,
    name,
    path,
    createdAt,
    active: true,
  };
}

function createWorkspace(
  overrides: Partial<ProjectWorkspace> = {}
): ProjectWorkspace {
  return {
    ...createDefaultWorkspace(),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("workspace utils", () => {
  it("normalizeWorkspace repairs stale tabs, titles and history", () => {
    const workspace = createWorkspace({
      tabsById: {
        s1: {
          id: "s1",
          kind: "session",
          resourceId: "s1",
          title: "旧标题",
          closable: true,
          pinned: false,
          dirty: false,
          preview: false,
          createdAt: 10,
          lastActivatedAt: 10,
        },
        orphan: {
          id: "orphan",
          kind: "session",
          resourceId: "orphan",
          title: "孤儿页签",
          closable: true,
          pinned: false,
          dirty: false,
          preview: false,
          createdAt: 20,
          lastActivatedAt: 20,
        },
      },
      panesById: {
        secondary: {
          id: "secondary",
          tabIds: [SETTINGS_ID, "s1", "missing", "s2"],
          activeTabId: "missing",
          history: ["s1", "missing", "s2"],
        },
      },
      activePaneId: "secondary",
      focusedTabId: "missing",
    });

    const normalized = normalizeWorkspace(workspace, [
      createSession("s1", "会话一"),
      createSession("s2", "会话二", 200),
    ]);

    expect(normalized.panesById[MAIN_PANE_ID]).toBeUndefined();
    expect(normalized.layout.root).toEqual({ type: "pane", paneId: "secondary" });
    expect(normalized.panesById.secondary.tabIds).toEqual([SETTINGS_ID, "s1", "s2"]);
    expect(normalized.panesById.secondary.history).toEqual(["s1", "s2"]);
    expect(normalized.panesById.secondary.activeTabId).toBe("s2");
    expect(normalized.tabsById.s1.title).toBe("会话一");
    expect(normalized.tabsById.s2.title).toBe("会话二");
    expect(normalized.tabsById[SETTINGS_ID]).toBeDefined();
    expect(normalized.tabsById.orphan).toBeUndefined();
    expect(normalized.focusedTabId).toBe("s2");
  });

  it("normalizeWorkspace falls back to main pane when active pane is invalid", () => {
    const workspace = createWorkspace({
      activePaneId: "ghost",
      focusedTabId: "ghost-tab",
    });

    const normalized = normalizeWorkspace(workspace, []);

    expect(normalized.activePaneId).toBe(MAIN_PANE_ID);
    expect(normalized.focusedTabId).toBeNull();
  });

  it("syncWorkspaceSnapshot reflects active pane tabs", () => {
    const workspace = createWorkspace({
      tabsById: {
        a: {
          id: "a",
          kind: "session",
          resourceId: "a",
          title: "A",
          closable: true,
          pinned: false,
          dirty: false,
          preview: false,
          createdAt: 1,
          lastActivatedAt: 1,
        },
      },
      panesById: {
        [MAIN_PANE_ID]: {
          id: MAIN_PANE_ID,
          tabIds: ["a"],
          activeTabId: "a",
          history: ["a"],
        },
      },
      activePaneId: MAIN_PANE_ID,
      focusedTabId: "a",
    });

    expect(syncWorkspaceSnapshot(workspace)).toMatchObject({
      openTabs: ["a"],
      activeSessionId: "a",
      activePaneId: MAIN_PANE_ID,
      focusedTabId: "a",
    });
  });

  it("openTabInWorkspace creates and activates a missing session tab", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T10:00:00Z"));

    const workspace = createDefaultWorkspace();
    const nextWorkspace = openTabInWorkspace(
      workspace,
      "s1",
      [createSession("s1", "新会话", 123)]
    );

    expect(nextWorkspace.panesById[MAIN_PANE_ID].tabIds).toEqual(["s1"]);
    expect(nextWorkspace.panesById[MAIN_PANE_ID].activeTabId).toBe("s1");
    expect(nextWorkspace.focusedTabId).toBe("s1");
    expect(nextWorkspace.tabsById.s1.title).toBe("新会话");
    expect(nextWorkspace.tabsById.s1.lastActivatedAt).toBe(
      new Date("2026-05-15T10:00:00Z").getTime()
    );
  });

  it("activateTabInWorkspace updates active tab and keeps history order", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T11:00:00Z"));

    const workspace = createWorkspace({
      tabsById: {
        a: {
          id: "a",
          kind: "session",
          resourceId: "a",
          title: "A",
          closable: true,
          pinned: false,
          dirty: false,
          preview: false,
          createdAt: 1,
          lastActivatedAt: 1,
        },
        b: {
          id: "b",
          kind: "session",
          resourceId: "b",
          title: "B",
          closable: true,
          pinned: false,
          dirty: false,
          preview: false,
          createdAt: 2,
          lastActivatedAt: 2,
        },
      },
      panesById: {
        [MAIN_PANE_ID]: {
          id: MAIN_PANE_ID,
          tabIds: ["a", "b"],
          activeTabId: "a",
          history: ["a", "b"],
        },
      },
      activePaneId: MAIN_PANE_ID,
      focusedTabId: "a",
    });

    const nextWorkspace = activateTabInWorkspace(workspace, "b");

    expect(nextWorkspace.panesById[MAIN_PANE_ID].activeTabId).toBe("b");
    expect(nextWorkspace.panesById[MAIN_PANE_ID].history).toEqual(["a", "b"]);
    expect(nextWorkspace.focusedTabId).toBe("b");
    expect(nextWorkspace.tabsById.b.lastActivatedAt).toBe(
      new Date("2026-05-15T11:00:00Z").getTime()
    );
  });

  it("closeTabInWorkspace removes tab and falls back using pane history", () => {
    const workspace = createWorkspace({
      tabsById: {
        a: {
          id: "a",
          kind: "session",
          resourceId: "a",
          title: "A",
          closable: true,
          pinned: false,
          dirty: false,
          preview: false,
          createdAt: 1,
          lastActivatedAt: 1,
        },
        b: {
          id: "b",
          kind: "session",
          resourceId: "b",
          title: "B",
          closable: true,
          pinned: false,
          dirty: false,
          preview: false,
          createdAt: 2,
          lastActivatedAt: 2,
        },
      },
      panesById: {
        [MAIN_PANE_ID]: {
          id: MAIN_PANE_ID,
          tabIds: ["a", "b"],
          activeTabId: "b",
          history: ["a", "b"],
        },
      },
      activePaneId: MAIN_PANE_ID,
      focusedTabId: "b",
    });

    const nextWorkspace = closeTabInWorkspace(workspace, "b");

    expect(nextWorkspace.tabsById.b).toBeUndefined();
    expect(nextWorkspace.panesById[MAIN_PANE_ID].tabIds).toEqual(["a"]);
    expect(nextWorkspace.panesById[MAIN_PANE_ID].activeTabId).toBe("a");
    expect(nextWorkspace.focusedTabId).toBe("a");
  });

  it("reorderTabsInWorkspace reorders tabs before and after target", () => {
    const workspace = createWorkspace({
      panesById: {
        [MAIN_PANE_ID]: {
          id: MAIN_PANE_ID,
          tabIds: ["a", "b", "c"],
          activeTabId: "b",
          history: ["a", "b", "c"],
        },
      },
    });

    const before = reorderTabsInWorkspace(workspace, "c", "a", "before");
    const after = reorderTabsInWorkspace(workspace, "a", "c", "after");

    expect(before.panesById[MAIN_PANE_ID].tabIds).toEqual(["c", "a", "b"]);
    expect(after.panesById[MAIN_PANE_ID].tabIds).toEqual(["b", "c", "a"]);
  });

  it("moveTabToPaneInWorkspace docks a tab into another pane at the requested position", () => {
    const workspace = createWorkspace({
      panesById: {
        main: { id: "main", tabIds: ["a", "b"], activeTabId: "b", history: ["a", "b"] },
        right: { id: "right", tabIds: ["c", "d"], activeTabId: "c", history: ["c", "d"] },
      },
      layout: {
        root: {
          type: "split",
          direction: "horizontal",
          ratio: 0.5,
          first: { type: "pane", paneId: "main" },
          second: { type: "pane", paneId: "right" },
        },
      },
    });

    const next = moveTabToPaneInWorkspace(workspace, "b", "main", "right", "d", "before");

    expect(next.panesById.main.tabIds).toEqual(["a"]);
    expect(next.panesById.right.tabIds).toEqual(["c", "b", "d"]);
    expect(next.panesById.right.activeTabId).toBe("b");
    expect(next.activePaneId).toBe("right");
    expect(next.focusedTabId).toBe("b");
  });

  it("moveTabToPaneInWorkspace collapses a source pane after moving its last tab", () => {
    const workspace = createWorkspace({
      panesById: {
        main: { id: "main", tabIds: ["a"], activeTabId: "a", history: ["a"] },
        bottom: { id: "bottom", tabIds: ["b"], activeTabId: "b", history: ["b"] },
      },
      layout: {
        root: {
          type: "split",
          direction: "vertical",
          ratio: 0.5,
          first: { type: "pane", paneId: "main" },
          second: { type: "pane", paneId: "bottom" },
        },
      },
    });

    const next = moveTabToPaneInWorkspace(workspace, "b", "bottom", "main");

    expect(next.panesById.bottom).toBeUndefined();
    expect(next.panesById.main.tabIds).toEqual(["a", "b"]);
    expect(next.layout.root).toEqual({ type: "pane", paneId: "main" });
  });

  it("splitTabInWorkspace moves a tab into a right split", () => {
    const workspace = createWorkspace({
      panesById: {
        [MAIN_PANE_ID]: {
          id: MAIN_PANE_ID,
          tabIds: ["a", "b"],
          activeTabId: "b",
          history: ["a", "b"],
        },
      },
      focusedTabId: "b",
    });

    const next = splitTabInWorkspace(workspace, "b", "right", MAIN_PANE_ID, "move", "right-pane");

    expect(next.panesById.main.tabIds).toEqual(["a"]);
    expect(next.panesById.main.activeTabId).toBe("a");
    expect(next.panesById["right-pane"]).toMatchObject({
      tabIds: ["b"],
      activeTabId: "b",
    });
    expect(next.layout.root).toEqual({
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "pane", paneId: MAIN_PANE_ID },
      second: { type: "pane", paneId: "right-pane" },
    });
    expect(next.activePaneId).toBe("right-pane");
    expect(next.focusedTabId).toBe("b");
  });

  it("splitTabInWorkspace refuses to split a pane with only one tab", () => {
    const workspace = createWorkspace({
      panesById: {
        [MAIN_PANE_ID]: {
          id: MAIN_PANE_ID,
          tabIds: ["a"],
          activeTabId: "a",
          history: ["a"],
        },
      },
    });

    const next = splitTabInWorkspace(workspace, "a", "up", MAIN_PANE_ID, "move", "upper-pane");

    expect(next).toBe(workspace);
    expect(next.panesById["upper-pane"]).toBeUndefined();
  });

  it("splitTabInWorkspace copies a tab into a new split without removing the source", () => {
    const workspace = createWorkspace({
      panesById: {
        [MAIN_PANE_ID]: {
          id: MAIN_PANE_ID,
          tabIds: ["a"],
          activeTabId: "a",
          history: ["a"],
        },
      },
    });

    const next = splitTabInWorkspace(workspace, "a", "down", MAIN_PANE_ID, "copy", "lower-pane");

    expect(next.panesById.main.tabIds).toEqual(["a"]);
    expect(next.panesById["lower-pane"].tabIds).toEqual(["a"]);
    expect(next.layout.root).toMatchObject({ type: "split", direction: "vertical" });
  });

  it("closeTabInWorkspace closes only the requested split copy", () => {
    const workspace = createWorkspace({
      tabsById: {
        a: {
          id: "a",
          kind: "session",
          resourceId: "a",
          title: "A",
          closable: true,
          pinned: false,
          dirty: false,
          preview: false,
          createdAt: 1,
          lastActivatedAt: 1,
        },
      },
      panesById: {
        main: { id: "main", tabIds: ["a"], activeTabId: "a", history: ["a"] },
        right: { id: "right", tabIds: ["a"], activeTabId: "a", history: ["a"] },
      },
      layout: {
        root: {
          type: "split",
          direction: "horizontal",
          ratio: 0.5,
          first: { type: "pane", paneId: "main" },
          second: { type: "pane", paneId: "right" },
        },
      },
    });

    const next = closeTabInWorkspace(workspace, "a", "right");

    expect(next.panesById.main.tabIds).toEqual(["a"]);
    expect(next.panesById.right).toBeUndefined();
    expect(next.tabsById.a).toBeDefined();
  });

  it("normalizeWorkspace removes nested empty panes from an old layout", () => {
    const session = createSession("a", "A");
    const workspace = createWorkspace({
      panesById: {
        main: { id: "main", tabIds: ["a"], activeTabId: "a", history: ["a"] },
        emptyRight: { id: "emptyRight", tabIds: [], activeTabId: null, history: [] },
        emptyBottom: { id: "emptyBottom", tabIds: [], activeTabId: null, history: [] },
      },
      layout: {
        root: {
          type: "split",
          direction: "horizontal",
          ratio: 0.5,
          first: { type: "pane", paneId: "main" },
          second: {
            type: "split",
            direction: "vertical",
            ratio: 0.5,
            first: { type: "pane", paneId: "emptyRight" },
            second: { type: "pane", paneId: "emptyBottom" },
          },
        },
      },
      activePaneId: "emptyBottom",
      focusedTabId: null,
    });

    const next = normalizeWorkspace(workspace, [session]);

    expect(Object.keys(next.panesById)).toEqual(["main"]);
    expect(next.layout.root).toEqual({ type: "pane", paneId: "main" });
    expect(next.activePaneId).toBe("main");
    expect(next.focusedTabId).toBe("a");
  });

  it("closeTabInWorkspace collapses a split when its pane becomes empty", () => {
    const workspace = createWorkspace({
      tabsById: {
        a: { id: "a", kind: "session", resourceId: "a", title: "A", closable: true, pinned: false, dirty: false, preview: false, createdAt: 1, lastActivatedAt: 1 },
        b: { id: "b", kind: "session", resourceId: "b", title: "B", closable: true, pinned: false, dirty: false, preview: false, createdAt: 2, lastActivatedAt: 2 },
      },
      panesById: {
        main: { id: "main", tabIds: ["a"], activeTabId: "a", history: ["a"] },
        right: { id: "right", tabIds: ["b"], activeTabId: "b", history: ["b"] },
      },
      layout: {
        root: {
          type: "split",
          direction: "horizontal",
          ratio: 0.5,
          first: { type: "pane", paneId: "main" },
          second: { type: "pane", paneId: "right" },
        },
      },
      activePaneId: "right",
      focusedTabId: "b",
    });

    const next = closeTabInWorkspace(workspace, "b");

    expect(next.panesById.right).toBeUndefined();
    expect(next.layout.root).toEqual({ type: "pane", paneId: "main" });
    expect(next.activePaneId).toBe("main");
    expect(next.focusedTabId).toBe("a");
  });
});
