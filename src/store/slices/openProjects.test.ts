import { beforeEach, expect, it, vi } from "vitest";
import { listOpenProjectWindows } from "@/lib/api";
import { useOpenProjectsStore } from "./openProjects";

vi.mock("@/lib/api", () => ({ listOpenProjectWindows: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  useOpenProjectsStore.setState({ windows: [], loading: false });
});

it("replaces snapshots so closed windows disappear", async () => {
  vi.mocked(listOpenProjectWindows).mockResolvedValueOnce([
    { windowLabel: "a", mode: "project", projectPath: "/a" },
    { windowLabel: "b", mode: "project", projectPath: "/b" },
  ]).mockResolvedValueOnce([]);
  await useOpenProjectsStore.getState().setOpenProjectWindows();
  expect(useOpenProjectsStore.getState().windows).toHaveLength(2);
  await useOpenProjectsStore.getState().setOpenProjectWindows();
  expect(useOpenProjectsStore.getState().windows).toEqual([]);
});

it("retains the last snapshot after failure and permits retry", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(listOpenProjectWindows).mockRejectedValueOnce(new Error("IPC unavailable")).mockResolvedValueOnce([]);
  await useOpenProjectsStore.getState().setOpenProjectWindows();
  expect(useOpenProjectsStore.getState().loading).toBe(false);
  expect(log).toHaveBeenCalled();
  await useOpenProjectsStore.getState().setOpenProjectWindows();
  expect(listOpenProjectWindows).toHaveBeenCalledTimes(2);
  log.mockRestore();
});
