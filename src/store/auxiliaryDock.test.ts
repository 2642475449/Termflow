import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultAuxiliaryDockWidth,
  effectiveAuxiliaryDockWidth,
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
      widths: {},
      initialWidths: {},
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
    expect(useAuxiliaryDockStore.getState().widths["task-monitor"]).toBe(MIN_AUXILIARY_DOCK_WIDTH);
    store.setWidth(10_000);
    expect(useAuxiliaryDockStore.getState().widths["task-monitor"]).toBe(MAX_AUXILIARY_DOCK_WIDTH);

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

it("remembers separate widths across reopening, project resets and restarts", async () => {
  const values = stubDockStorage();
  vi.resetModules();
  const { useAuxiliaryDockStore: store } = await import("./auxiliaryDock");
  store.getState().toggle();
  expect(defaultAuxiliaryDockWidth("task-monitor", 1600)).toBe(300);
  store.getState().setWidth(260);
  store.getState().openFile({ projectPath: "D:/repo", path: "D:/repo/one.md" });
  store.getState().setWidth(610);
  store.getState().openFile({ projectPath: "D:/repo", path: "D:/repo/two.md" });
  expect(store.getState().widths.file).toBe(610);
  store.getState().activateTab("aux:task-monitor");
  expect(store.getState().widths["task-monitor"]).toBe(260);
  store.getState().toggle();
  store.getState().toggle();
  store.getState().reset();
  store.getState().toggle();
  const widths = { "task-monitor": 260, file: 610 };
  expect(store.getState().widths).toEqual(widths);
  expect(JSON.parse(values.get("termflow-auxiliary-dock") ?? "{}").state).toEqual({ widths });
  vi.resetModules();
  const { useAuxiliaryDockStore: reloaded } = await import("./auxiliaryDock");
  expect(reloaded.getState()).toMatchObject({ widths, initialWidths: {}, open: false, tabs: [], activeTabId: null });
});

it("ignores the legacy shared width so a wide document cannot become the monitor default", async () => {
  const values = stubDockStorage();
  values.set("termflow-auxiliary-dock", JSON.stringify({ state: { width: 880 }, version: 0 }));
  vi.resetModules();
  const { useAuxiliaryDockStore: store } = await import("./auxiliaryDock");
  expect(store.getState().widths).toEqual({});
  expect(defaultAuxiliaryDockWidth("task-monitor", 1600)).toBe(300);
  expect(defaultAuxiliaryDockWidth("file", 1600)).toBe(608);
});

it("validates persisted widths independently and ignores unknown content types", async () => {
  const values = stubDockStorage();
  values.set("termflow-auxiliary-dock", JSON.stringify({ state: { widths: {
    "task-monitor": 10, file: 10000, review: "invalid", task: null, terminal: 510, unknown: 600,
  } }, version: 0 }));
  vi.resetModules();
  const { useAuxiliaryDockStore: store } = await import("./auxiliaryDock");
  expect(store.getState().widths).toEqual({ "task-monitor": 220, file: 880, terminal: 510 });
});

describe("adaptive dock layout", () => {
  beforeEach(() => useAuxiliaryDockStore.setState({ widths: {}, initialWidths: {}, tabs: [], activeTabId: null, open: false }));

  it("keeps the first reading width stable across updates and temporary window constraints", () => {
    const store = useAuxiliaryDockStore.getState();
    store.openFile({ projectPath: "D:/repo", path: "D:/repo/one.md" });
    store.initializeWidth("file", 1600);
    store.initializeWidth("file", 1000);
    expect(useAuxiliaryDockStore.getState().initialWidths.file).toBe(608);
    expect(effectiveAuxiliaryDockWidth(608, 800)).toBeCloseTo(319.6);
    expect(effectiveAuxiliaryDockWidth(608, 1600)).toBe(608);
    expect(useAuxiliaryDockStore.getState().widths).toEqual({});
    store.setWidth(700);
    expect(effectiveAuxiliaryDockWidth(useAuxiliaryDockStore.getState().widths.file!, 700)).toBeCloseTo(279.6);
    expect(useAuxiliaryDockStore.getState().widths.file).toBe(700);
  });

  it("restores the monitor on document close and resets only the active category", () => {
    const store = useAuxiliaryDockStore.getState();
    store.toggle();
    store.setWidth(270);
    store.openFile({ projectPath: "D:/repo", path: "D:/repo/one.md" });
    store.setWidth(650);
    store.resetWidth(1500);
    expect(useAuxiliaryDockStore.getState().widths).toEqual({ "task-monitor": 270 });
    expect(useAuxiliaryDockStore.getState().initialWidths.file).toBe(570);
    store.closeTab(useAuxiliaryDockStore.getState().activeTabId!);
    expect(useAuxiliaryDockStore.getState().activeTabId).toBe("aux:task-monitor");
    expect(useAuxiliaryDockStore.getState().widths["task-monitor"]).toBe(270);
  });

  it.each([0, 200, 500, 800, 1200, 1800])("reserves usable main workspace at host width %i", (hostWidth) => {
    const width = effectiveAuxiliaryDockWidth(880, hostWidth);
    expect(width).toBeGreaterThanOrEqual(0);
    const available = Math.max(0, hostWidth - 1);
    expect(available - width).toBeGreaterThanOrEqual(Math.min(480, available * 0.6) - 0.001);
  });
});
