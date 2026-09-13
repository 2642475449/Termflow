import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { listScheduledTaskRuns, listScheduledTasks } from "@/lib/api";
import {
  refreshScheduledTasks,
  startScheduledTaskSync,
  useScheduledTaskStore,
} from "./scheduledTasks";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@/lib/api", () => ({
  listScheduledTasks: vi.fn(),
  listScheduledTaskRuns: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  useScheduledTaskStore.setState({
    tasks: [], runs: [], loading: false, initialized: false, error: null, scope: "current", selectedRunId: null, editor: null,
  });
  vi.mocked(listScheduledTasks).mockResolvedValue([]);
  vi.mocked(listScheduledTaskRuns).mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

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
