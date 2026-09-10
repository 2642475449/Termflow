import { beforeEach, expect, it, vi } from "vitest";
import type { GitRemoteState } from "@/lib/gitRemoteAction";
vi.mock("@/lib/api", () => ({ gitRemoteState: vi.fn(), gitFetch: vi.fn(), gitRepoInfo: vi.fn(), gitStatus: vi.fn() }));
vi.mock("@/lib/gitGraphEvents", () => ({ dispatchGitGraphRefresh: vi.fn() }));
import { gitRemoteState, gitFetch, gitRepoInfo, gitStatus } from "@/lib/api";
import { useGitRemoteStore } from "./gitRemote";

const state: GitRemoteState = {
  requiresFetch: false,
  branchName: "main",
  remotes: [],
  upstream: null,
  hasCommit: false,
  branches: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  useGitRemoteStore.setState({ entries: {}, busy: {}, fetchErrors: {}, fetching: {}, fetchedAt: {} });
});

it("keeps errors distinct from an empty remote list", async () => {
  vi.mocked(gitRemoteState).mockRejectedValue(new Error("unavailable"));
  await useGitRemoteStore.getState().refresh("a");
  expect(useGitRemoteStore.getState().entries.a.data).toBeNull();
  expect(useGitRemoteStore.getState().entries.a.error).toContain("unavailable");
  vi.mocked(gitRemoteState).mockResolvedValue(state);
  await useGitRemoteStore.getState().refresh("a");
  expect(useGitRemoteStore.getState().entries.a).toEqual({
    data: state,
    error: null,
  });
});

it("ignores an older response arriving after a newer snapshot", async () => {
  let resolveOld!: (value: GitRemoteState) => void;
  vi.mocked(gitRemoteState).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const old = useGitRemoteStore.getState().refresh("a");
  vi.mocked(gitRemoteState).mockResolvedValue(state);
  await useGitRemoteStore.getState().refresh("a");
  resolveOld({ ...state, upstream: "stale" });
  await old;
  expect(useGitRemoteStore.getState().entries.a.data?.upstream).toBeNull();
});

it("isolates operation and fetch status by project", () => {
  useGitRemoteStore.getState().setBusy("a", "push");
  useGitRemoteStore.getState().setFetchError("a", "offline");
  expect(useGitRemoteStore.getState().busy.b).toBeUndefined();
  expect(useGitRemoteStore.getState().fetchErrors.b).toBeUndefined();
});


it("coalesces concurrent refreshes and manual refresh bypasses the automatic interval", async () => {
  let resolveFetch!: (result: { success: boolean; message: string }) => void;
  vi.mocked(gitFetch).mockImplementationOnce(() => new Promise((resolve) => { resolveFetch = resolve; }));
  vi.mocked(gitRemoteState).mockResolvedValue(state);
  vi.mocked(gitRepoInfo).mockResolvedValue({ isRepo: true, branchInfo: null });
  vi.mocked(gitStatus).mockResolvedValue([]);
  const a = useGitRemoteStore.getState().fetchUpdates("a");
  const b = useGitRemoteStore.getState().fetchUpdates("a", true);
  expect(a).toBe(b);
  await Promise.resolve();
  expect(gitFetch).toHaveBeenCalledTimes(1);
  resolveFetch({ success: true, message: "ok" }); await a;
  expect(useGitRemoteStore.getState().fetching.a).toBe(false);
  await useGitRemoteStore.getState().fetchUpdates("a");
  expect(gitFetch).toHaveBeenCalledTimes(1);
  vi.mocked(gitFetch).mockResolvedValue({ success: true, message: "ok" });
  await useGitRemoteStore.getState().fetchUpdates("a", true);
  expect(gitFetch).toHaveBeenCalledTimes(2);
});

it("retains refresh errors for the refresh icon and clears them after retry", async () => {
  vi.mocked(gitFetch).mockResolvedValue({ success: false, message: "offline" });
  await useGitRemoteStore.getState().fetchUpdates("a", true);
  expect(useGitRemoteStore.getState().fetchErrors.a).toContain("offline");
  expect(useGitRemoteStore.getState().fetching.a).toBe(false);
  vi.mocked(gitFetch).mockResolvedValue({ success: true, message: "ok" });
  vi.mocked(gitRemoteState).mockResolvedValue(state);
  vi.mocked(gitRepoInfo).mockResolvedValue({ isRepo: true, branchInfo: null });
  vi.mocked(gitStatus).mockResolvedValue([]);
  await useGitRemoteStore.getState().fetchUpdates("a", true);
  expect(useGitRemoteStore.getState().fetchErrors.a).toBeNull();
});

it("does not start an automatic fetch while a user operation owns the project", async () => {
  useGitRemoteStore.getState().setBusy("a", "sync");
  await useGitRemoteStore.getState().fetchUpdates("a");
  expect(gitFetch).not.toHaveBeenCalled();
});
