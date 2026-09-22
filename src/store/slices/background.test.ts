import { beforeEach, expect, it, vi } from "vitest";
import { completeWorkspaceClose, exitBackgroundApplication, getBackgroundSettings, setBackgroundSettings } from "@/lib/api";
import { chooseWorkspaceClose, requestWorkspaceClose, useBackgroundStore } from "./background";
import { useApplicationUpdateStore } from "./applicationUpdate";

vi.mock("@/lib/api", () => ({
  completeWorkspaceClose: vi.fn().mockResolvedValue(undefined),
  exitBackgroundApplication: vi.fn().mockResolvedValue(undefined),
  getBackgroundSettings: vi.fn(),
  setBackgroundSettings: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
  useBackgroundStore.setState({ settings: { runInBackground: false, askBeforeClose: true }, ready: false, busy: false, promptOpen: false, remember: true });
  useApplicationUpdateStore.setState({ phase: "idle" });
  vi.mocked(getBackgroundSettings).mockResolvedValue({ runInBackground: false, askBeforeClose: true });
});

it("asks on first close without closing the workspace", async () => {
  await requestWorkspaceClose();
  expect(useBackgroundStore.getState().promptOpen).toBe(true);
  expect(completeWorkspaceClose).not.toHaveBeenCalled();
});

it("explicit project close offers direct close without changing background preferences", async () => {
  useBackgroundStore.setState({ settings: { runInBackground: true, askBeforeClose: false } });
  await requestWorkspaceClose(false, true);
  expect(useBackgroundStore.getState()).toMatchObject({ promptOpen: true, remember: false });
  expect(getBackgroundSettings).not.toHaveBeenCalled();
  expect(completeWorkspaceClose).not.toHaveBeenCalled();
  await chooseWorkspaceClose(false);
  expect(completeWorkspaceClose).toHaveBeenCalledWith(false);
  expect(setBackgroundSettings).not.toHaveBeenCalled();
});

it("guards explicit project close during update download", async () => {
  useApplicationUpdateStore.setState({ phase: "downloading" });
  await expect(requestWorkspaceClose(false, true)).rejects.toThrow("application-update-in-progress");
  expect(useBackgroundStore.getState().promptOpen).toBe(false);
  expect(completeWorkspaceClose).not.toHaveBeenCalled();
});

it("remembers the background choice before hiding", async () => {
  await chooseWorkspaceClose(true);
  expect(setBackgroundSettings).toHaveBeenCalledWith({ runInBackground: true, askBeforeClose: false });
  expect(completeWorkspaceClose).toHaveBeenCalledWith(true);
  expect(vi.mocked(setBackgroundSettings).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(completeWorkspaceClose).mock.invocationCallOrder[0]);
});

it("can close just once without changing the preference", async () => {
  useBackgroundStore.setState({ remember: false });
  await chooseWorkspaceClose(false);
  expect(setBackgroundSettings).not.toHaveBeenCalled();
  expect(completeWorkspaceClose).toHaveBeenCalledWith(false);
});

it("reads the shared preference instead of trusting a stale window cache", async () => {
  vi.mocked(getBackgroundSettings).mockResolvedValue({ runInBackground: true, askBeforeClose: false });
  await requestWorkspaceClose();
  expect(completeWorkspaceClose).toHaveBeenCalledWith(true);
  expect(useBackgroundStore.getState().promptOpen).toBe(false);
});

it("honors the saved direct-close preference", async () => {
  vi.mocked(getBackgroundSettings).mockResolvedValue({ runInBackground: false, askBeforeClose: false });
  await requestWorkspaceClose();
  expect(completeWorkspaceClose).toHaveBeenCalledWith(false);
});

it("keeps the window and dialog available when saving fails", async () => {
  useBackgroundStore.setState({ promptOpen: true });
  vi.mocked(setBackgroundSettings).mockRejectedValueOnce(new Error("storage unavailable"));
  await expect(chooseWorkspaceClose(true)).rejects.toThrow("storage unavailable");
  expect(completeWorkspaceClose).not.toHaveBeenCalled();
  expect(useBackgroundStore.getState()).toMatchObject({ busy: false, promptOpen: true });
});

it("explicit tray exit bypasses the background preference", async () => {
  await requestWorkspaceClose(true);
  expect(exitBackgroundApplication).toHaveBeenCalledOnce();
  expect(completeWorkspaceClose).not.toHaveBeenCalled();
});

it("guards exit during update download", async () => {
  useApplicationUpdateStore.setState({ phase: "downloading" });
  await expect(requestWorkspaceClose(true)).rejects.toThrow("application-update-in-progress");
  expect(exitBackgroundApplication).not.toHaveBeenCalled();
});

it("ignores repeated requests while loading the preference", async () => {
  let resolve!: (value: { runInBackground: boolean; askBeforeClose: boolean }) => void;
  vi.mocked(getBackgroundSettings).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const first = requestWorkspaceClose();
  await requestWorkspaceClose();
  expect(getBackgroundSettings).toHaveBeenCalledOnce();
  resolve({ runInBackground: true, askBeforeClose: false });
  await first;
  expect(completeWorkspaceClose).toHaveBeenCalledOnce();
});
