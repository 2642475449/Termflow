import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AUXILIARY_DOCK_WIDTH,
  MAX_AUXILIARY_DOCK_WIDTH,
  MIN_AUXILIARY_DOCK_WIDTH,
  useAuxiliaryDockStore,
} from "./auxiliaryDock";

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

});
