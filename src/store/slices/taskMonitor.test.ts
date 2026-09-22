import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emit, listen } from "@tauri-apps/api/event";
import { requestTaskMonitorTabClose, startTaskMonitorSync, useTaskMonitorStore } from "./taskMonitor";
import { requestWorkspaceClose } from "./background";

vi.mock("./background", () => ({ requestWorkspaceClose: vi.fn().mockResolvedValue(undefined) }));

const mocks = vi.hoisted(() => ({
  state: { windowLabel: "project-a", currentProject: { path: "/a" }, sessions: [], panesById: {}, tabsById: {}, closeTab: vi.fn() },
  unsubscribe: vi.fn(),
}));
vi.mock("@/store", () => ({ useAppStore: {
  getState: () => mocks.state,
  subscribe: () => mocks.unsubscribe,
} }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(emit).mockResolvedValue();
  useTaskMonitorStore.setState({ snapshots: {} });
});
afterEach(() => vi.restoreAllMocks());

it("publishes current project metadata and receives remote window snapshots", async () => {
  const unlisten = vi.fn();
  vi.mocked(listen).mockResolvedValue(unlisten);
  const stop = startTaskMonitorSync();
  await vi.waitFor(() => expect(emit).toHaveBeenCalled());
  expect(useTaskMonitorStore.getState().snapshots["project-a"]).toEqual({
    windowLabel: "project-a", projectPath: "/a", tabs: [],
  });
  const handler = vi.mocked(listen).mock.calls[0][1];
  handler({ event: "snapshot", id: 1, payload: { windowLabel: "project-b", projectPath: "/b", tabs: [] } });
  expect(useTaskMonitorStore.getState().snapshots["project-b"].projectPath).toBe("/b");
  stop();
  expect(unlisten).toHaveBeenCalledTimes(4);
  expect(mocks.unsubscribe).toHaveBeenCalledOnce();
});

it("cleans up listeners that finish registering after unmount", async () => {
  const unlisten = vi.fn();
  let resolveListener: (cleanup: () => void) => void = () => {};
  vi.mocked(listen).mockImplementation(() => new Promise((resolve) => { resolveListener = resolve; }));
  // 同时注册的监听器共用一个延迟结果，模拟 WebView 异步注册。
  const pending = new Promise<() => void>((resolve) => { resolveListener = resolve; });
  vi.mocked(listen).mockReturnValue(pending);
  const stop = startTaskMonitorSync();
  stop();
  resolveListener(unlisten);
  await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(4));
  expect(emit).not.toHaveBeenCalled();
});

it("sends close requests to the target project window", async () => {
  await requestTaskMonitorTabClose({ windowLabel: "project-b", tabId: "session-1" });
  expect(emit).toHaveBeenCalledWith("termflow-task-monitor-close-request", {
    windowLabel: "project-b", tabId: "session-1",
  });
});

it("only opens the close dialog for the matching project and window", async () => {
  vi.mocked(listen).mockResolvedValue(vi.fn());
  const stop = startTaskMonitorSync();
  await vi.waitFor(() => expect(emit).toHaveBeenCalled());
  const handler = vi.mocked(listen).mock.calls.find(([event]) => event === "termflow-task-monitor-project-close-request")![1];
  const send = (windowLabel: string, projectPath: string) => handler({ event: "close", id: 1, payload: { windowLabel, projectPath } });
  send("project-b", "/a");
  send("project-a", "/old");
  expect(requestWorkspaceClose).not.toHaveBeenCalled();
  send("project-a", "/a");
  expect(requestWorkspaceClose).toHaveBeenCalledWith(false, true);
  stop();
  send("project-a", "/a");
  expect(requestWorkspaceClose).toHaveBeenCalledOnce();
});
