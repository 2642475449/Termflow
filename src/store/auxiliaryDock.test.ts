import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AUXILIARY_DOCK_WIDTH,
  MAX_AUXILIARY_DOCK_WIDTH,
  MIN_AUXILIARY_DOCK_WIDTH,
  useAuxiliaryDockStore,
} from "./auxiliaryDock";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function stubDockStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  return values;
}

describe("auxiliary dock store", () => {
  beforeEach(() => {
    useAuxiliaryDockStore.setState({
      open: false,
      width: DEFAULT_AUXILIARY_DOCK_WIDTH,
      tabs: [],
      activeTabId: null,
    });
  });

  it("reuses one temporary file preview while preserving pinned files", () => {
    const store = useAuxiliaryDockStore.getState();
    store.openFile({ projectPath: "D:/repo", path: "D:/repo/one.md" });
    const firstId = useAuxiliaryDockStore.getState().activeTabId!;
    store.pinTab(firstId);
    store.openFile({ projectPath: "D:/repo", path: "D:/repo/two.md" });
    store.openFile({ projectPath: "D:/repo", path: "D:/repo/three.md" });

    const state = useAuxiliaryDockStore.getState();
    expect(state.tabs.map((tab) => tab.resourceId)).toEqual([
      "D:/repo/one.md",
      "D:/repo/three.md",
    ]);
    expect(state.tabs[0].preview).toBe(false);
    expect(state.tabs[1].preview).toBe(true);
  });

  it("focuses an existing session tab instead of duplicating it", () => {
    const store = useAuxiliaryDockStore.getState();
    store.openSession({
      sessionId: "session-1",
      projectPath: "D:/repo",
      title: "Old title",
      kind: "task",
    });
    store.openSession({
      sessionId: "session-1",
      projectPath: "D:/repo",
      title: "New title",
      kind: "task",
    });

    const state = useAuxiliaryDockStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].title).toBe("New title");
    expect(state.open).toBe(true);
  });

  it("clamps width and activates the nearest tab after closing", () => {
    const store = useAuxiliaryDockStore.getState();
    store.setWidth(10);
    expect(useAuxiliaryDockStore.getState().width).toBe(MIN_AUXILIARY_DOCK_WIDTH);
    store.setWidth(10_000);
    expect(useAuxiliaryDockStore.getState().width).toBe(MAX_AUXILIARY_DOCK_WIDTH);

    store.openFile({ projectPath: "D:/repo", path: "D:/repo/one.md", preview: false });
    const first = useAuxiliaryDockStore.getState().activeTabId!;
    store.openFile({ projectPath: "D:/repo", path: "D:/repo/two.md", preview: false });
    const second = useAuxiliaryDockStore.getState().activeTabId!;
    store.closeTab(second);
    expect(useAuxiliaryDockStore.getState().activeTabId).toBe(first);
  });

  it("closes the dock after its last file is promoted away", () => {
    const store = useAuxiliaryDockStore.getState();
    store.openFile({ projectPath: "D:/repo", path: "D:/repo/one.md", preview: false });
    const fileTabId = useAuxiliaryDockStore.getState().activeTabId!;

    store.closeTab(fileTabId);

    expect(useAuxiliaryDockStore.getState()).toMatchObject({
      open: false,
      activeTabId: null,
      tabs: [],
    });
  });

  it("returns to a preferred session tab after closing its review", () => {
    const store = useAuxiliaryDockStore.getState();
    store.openSession({
      sessionId: "session-1",
      projectPath: "D:/repo",
      title: "Session",
      kind: "task",
    });
    const sessionTabId = useAuxiliaryDockStore.getState().activeTabId!;
    store.openReview({
      sessionId: "session-1",
      projectPath: "D:/repo",
      title: "Review",
    });
    const reviewTabId = useAuxiliaryDockStore.getState().activeTabId!;
    store.openFile({ projectPath: "D:/repo", path: "D:/repo/after.md", preview: false });
    store.activateTab(reviewTabId);

    store.closeTab(reviewTabId, sessionTabId);

    expect(useAuxiliaryDockStore.getState().activeTabId).toBe(sessionTabId);
  });

  it("reuses a single task monitor tab in the auxiliary dock", () => {
    const store = useAuxiliaryDockStore.getState();
    store.openTaskMonitor({ title: "任务监控", projectPath: "D:/repo" });
    store.openFile({ projectPath: "D:/repo", path: "D:/repo/one.md", preview: false });
    store.openTaskMonitor({ title: "Task Monitor", projectPath: "D:/repo" });

    const state = useAuxiliaryDockStore.getState();
    expect(state.tabs.filter((tab) => tab.kind === "task-monitor")).toHaveLength(1);
    expect(state.activeTabId).toBe("aux:task-monitor");
    expect(state.tabs.find((tab) => tab.id === "aux:task-monitor")?.title).toBe("Task Monitor");
  });

  it("opens the task monitor tab by default when toggled open with no existing tabs", () => {
    const store = useAuxiliaryDockStore.getState();
    store.toggle();

    const state = useAuxiliaryDockStore.getState();
    expect(state.open).toBe(true);
    expect(state.activeTabId).toBe("aux:task-monitor");
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].kind).toBe("task-monitor");
  });

});

it("starts at 280px and remembers the chosen width across reopening, project resets and restarts", async () => {
  const values = stubDockStorage();
  vi.resetModules();
  const { useAuxiliaryDockStore: store } = await import("./auxiliaryDock");
  store.getState().toggle();
  expect(store.getState().width).toBe(280);

  store.getState().setWidth(250);
  store.getState().toggle();
  store.getState().toggle();
  expect(store.getState().width).toBe(250);
  store.getState().reset();
  store.getState().toggle();
  expect(store.getState().width).toBe(250);
  expect(JSON.parse(values.get("termflow-auxiliary-dock") ?? "{}").state).toEqual({ width: 250 });

  vi.resetModules();
  const { useAuxiliaryDockStore: reloaded } = await import("./auxiliaryDock");
  expect(reloaded.getState()).toMatchObject({ width: 250, open: false, tabs: [], activeTabId: null });
});

it.each([
  [10, 220],
  [10_000, MAX_AUXILIARY_DOCK_WIDTH],
  ["invalid", 280],
  [null, 280],
])("normalizes saved width %j to %i on startup", async (savedWidth, expectedWidth) => {
  const values = stubDockStorage();
  values.set("termflow-auxiliary-dock", JSON.stringify({ state: { width: savedWidth }, version: 0 }));
  vi.resetModules();
  const { useAuxiliaryDockStore: store } = await import("./auxiliaryDock");
  expect(store.getState().width).toBe(expectedWidth);
});
