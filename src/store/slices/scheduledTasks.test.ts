import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { listScheduledTaskRuns, listScheduledTasks, runScheduledTaskNow } from "@/lib/api";
import type { ScheduledTaskRun } from "@/types";
import {
  refreshScheduledTasks,
  startScheduledTaskSync,
  startScheduledTaskRun,
  useScheduledTaskStore,
} from "./scheduledTasks";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@/lib/api", () => ({
  listScheduledTasks: vi.fn(),
  listScheduledTaskRuns: vi.fn(),
  runScheduledTaskNow: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  useScheduledTaskStore.setState({
    tasks: [], runs: [], loading: false, initialized: false, error: null, scope: "current", selectedRunId: null, editor: null,
    pendingRunTaskIds: [], listScrollPositions: {}, showAllRuns: false,
  });
  vi.mocked(listScheduledTasks).mockResolvedValue([]);
  vi.mocked(listScheduledTaskRuns).mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

it("preserves list position and expansion while visiting a run and another scope", () => {
  const state = useScheduledTaskStore.getState();
  state.setListScrollPosition("project-a", 320);
  state.setShowAllRuns(true);
  state.setSelectedRunId("run-a");
  state.setScope("all");
  state.setListScrollPosition("all", 80);
  state.setScope("project-a");
  expect(useScheduledTaskStore.getState()).toMatchObject({
    scope: "project-a", selectedRunId: null, showAllRuns: true,
    listScrollPositions: { "project-a": 320, all: 80 },
  });
});

it("blocks duplicate run submissions and selects the new run", async () => {
  let resolveRun!: (run: ScheduledTaskRun) => void;
  vi.mocked(runScheduledTaskNow).mockReturnValue(new Promise((resolve) => { resolveRun = resolve; }));
  const first = startScheduledTaskRun("task-a");
  await startScheduledTaskRun("task-a");
  expect(runScheduledTaskNow).toHaveBeenCalledTimes(1);
  expect(useScheduledTaskStore.getState().pendingRunTaskIds).toEqual(["task-a"]);
  const run = { id: "new-run", taskId: "task-a" } as ScheduledTaskRun;
  vi.mocked(listScheduledTaskRuns).mockResolvedValue([run]);
  resolveRun(run);
  await first;
  expect(useScheduledTaskStore.getState().selectedRunId).toBe("new-run");
  expect(useScheduledTaskStore.getState().pendingRunTaskIds).toEqual([]);
});

it("releases the run button after a failed request without losing the selected result", async () => {
  useScheduledTaskStore.getState().setSelectedRunId("old-run");
  vi.mocked(runScheduledTaskNow).mockRejectedValue(new Error("offline"));
  await expect(startScheduledTaskRun("task-a")).rejects.toThrow("offline");
  expect(useScheduledTaskStore.getState().pendingRunTaskIds).toEqual([]);
  expect(useScheduledTaskStore.getState().selectedRunId).toBe("old-run");
});

it("loads task and run snapshots together", async () => {
  vi.mocked(listScheduledTasks).mockResolvedValue([{ id: "task-a" }] as never);
  vi.mocked(listScheduledTaskRuns).mockResolvedValue([{ id: "run-a" }] as never);

  await refreshScheduledTasks();

  expect(useScheduledTaskStore.getState().tasks).toEqual([{ id: "task-a" }]);
  expect(useScheduledTaskStore.getState().runs).toEqual([{ id: "run-a" }]);
  expect(useScheduledTaskStore.getState().initialized).toBe(true);
});

it("refreshes after a native scheduled-task change event", async () => {
  const cleanup = vi.fn();
  vi.mocked(listen).mockResolvedValue(cleanup);

  const stop = startScheduledTaskSync();
  await vi.waitFor(() => expect(listen).toHaveBeenCalledOnce());
  const handler = vi.mocked(listen).mock.calls[0][1];
  handler({ event: "termflow:scheduled-tasks-changed", id: 1, payload: null });
  await vi.waitFor(() => expect(listScheduledTasks).toHaveBeenCalled());

  stop();
  expect(cleanup).toHaveBeenCalledOnce();
});
