// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AuxiliaryDock from "./AuxiliaryDock";
import { useAuxiliaryDockStore } from "@/store/auxiliaryDock";

vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/store", () => {
  const state = { currentProject: { path: "D:/repo" }, sessions: [], updateSession: vi.fn(), removeSession: vi.fn() };
  return { useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) };
});
vi.mock("antd", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => children;
  const Empty = Object.assign(() => null, { PRESENTED_IMAGE_SIMPLE: null });
  return { Dropdown: Pass, Tooltip: Pass, Empty, Input: () => null, Modal: () => null, Spin: () => null, message: { error: vi.fn() } };
});
vi.mock("@/components/AgentActivityIcon", () => ({ AgentActivityIcon: () => null }));
vi.mock("@/components/CheckpointReviewDrawer", () => ({ default: () => null }));
vi.mock("@/components/SessionCheckpointSummaryBar", () => ({ default: () => null }));
vi.mock("@/components/TaskMonitorPopover", () => ({ TaskMonitorPanel: () => null }));
vi.mock("@/components/AuxiliaryFileView", () => ({ default: () => null }));
vi.mock("@/lib/api", () => ({ cleanupSessionProcess: vi.fn(), searchProjectEntries: vi.fn() }));
vi.mock("@/lib/fileIcon", () => ({ getFileIconByName: () => null }));

let host: HTMLDivElement;
let root: Root;
let resizeHost: (width: number) => void;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) {
      resizeHost = (width) => callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    observe() {}
    disconnect() {}
  });
  useAuxiliaryDockStore.setState({ open: false, widths: {}, initialWidths: {}, tabs: [], activeTabId: null });
  host = document.createElement("div");
  host.getBoundingClientRect = () => ({ width: 1600 }) as DOMRect;
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(React.createElement(AuxiliaryDock, { onRequestTask: vi.fn(), onRequestTerminal: vi.fn() })));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const dockWidth = () => Number.parseFloat(host.querySelector("aside")!.style.width);

it("renders narrow monitor and wide documents, remembers dragging, and restores after a window resize", async () => {
  const store = useAuxiliaryDockStore.getState();
  await act(async () => store.toggle());
  expect(dockWidth()).toBe(300);
  await act(async () => store.openFile({ projectPath: "D:/repo", path: "D:/repo/one.md" }));
  expect(dockWidth()).toBe(608);
  const fileId = useAuxiliaryDockStore.getState().activeTabId!;
  host.querySelector("aside")!.getBoundingClientRect = () => ({ width: 608 }) as DOMRect;
  await act(async () => host.querySelector('[role="separator"]')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 1000 })));
  await act(async () => window.dispatchEvent(new PointerEvent("pointermove", { clientX: 908 })));
  await act(async () => window.dispatchEvent(new PointerEvent("pointerup")));
  expect(dockWidth()).toBe(700);
  await act(async () => store.activateTab("aux:task-monitor"));
  expect(dockWidth()).toBe(300);
  await act(async () => store.activateTab(fileId));
  expect(dockWidth()).toBe(700);
  await act(async () => resizeHost(800));
  expect(dockWidth()).toBeCloseTo(319.6);
  expect(useAuxiliaryDockStore.getState().widths.file).toBe(700);
  await act(async () => resizeHost(1600));
  expect(dockWidth()).toBe(700);
  await act(async () => store.closeTab(fileId));
  expect(dockWidth()).toBe(300);
});

it("keeps initial document width stable across file changes and resets only the active category", async () => {
  const store = useAuxiliaryDockStore.getState();
  await act(async () => store.openFile({ projectPath: "D:/repo", path: "D:/repo/one.md" }));
  await act(async () => resizeHost(1400));
  await act(async () => store.openFile({ projectPath: "D:/repo", path: "D:/repo/two.md" }));
  expect(dockWidth()).toBe(608);
  await act(async () => store.setWidth(700));
  await act(async () => host.querySelector('[role="separator"]')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(dockWidth()).toBe(532);
  expect(useAuxiliaryDockStore.getState().widths.file).toBeUndefined();
});
