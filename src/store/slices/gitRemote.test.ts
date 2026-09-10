import { beforeEach, expect, it, vi } from "vitest";
import type { GitRemoteState } from "@/lib/gitRemoteAction";
vi.mock("@/lib/api", () => ({ gitRemoteState: vi.fn() }));
import { gitRemoteState } from "@/lib/api";
import { useGitRemoteStore } from "./gitRemote";

const state: GitRemoteState = {
  branchName: "main",
  remotes: [],
  upstream: null,
  hasCommit: false,
  branches: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  useGitRemoteStore.setState({ entries: {}, busy: {}, fetchErrors: {} });
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
