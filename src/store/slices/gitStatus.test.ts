import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({ gitRepoInfo: vi.fn(), gitStatus: vi.fn() }));
import { gitRepoInfo, gitStatus } from "@/lib/api";
import { useGitStatusStore } from "./gitStatus";
import type { GitRepoInfo } from "@/types";

const info: GitRepoInfo = {
  isRepo: true,
  branchInfo: {
    branchName: "main",
    ahead: 2,
    behind: 0,
    isDetached: false,
    operationState: "clean",
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  useGitStatusStore.setState({ entries: {} });
  vi.mocked(gitStatus).mockResolvedValue([]);
});

it("preserves the last valid snapshot when reading status fails", async () => {
  vi.mocked(gitRepoInfo).mockResolvedValue(info);
  await useGitStatusStore.getState().refresh("A");
  vi.mocked(gitStatus).mockRejectedValue(new Error("index locked"));
  await useGitStatusStore.getState().refresh("A");
  expect(useGitStatusStore.getState().entries.A.isRepo).toBe(true);
  expect(useGitStatusStore.getState().entries.A.branchInfo?.ahead).toBe(2);
  expect(useGitStatusStore.getState().entries.A.error).toContain(
    "index locked",
  );
});

it("distinguishes initial read failure from a confirmed non-repository and recovers", async () => {
  vi.mocked(gitRepoInfo).mockRejectedValue(new Error("permission denied"));
  await useGitStatusStore.getState().refresh("A");
  expect(useGitStatusStore.getState().entries.A.isRepo).toBeNull();
  vi.mocked(gitRepoInfo).mockResolvedValue({ isRepo: false, branchInfo: null });
  await useGitStatusStore.getState().refresh("A");
  expect(useGitStatusStore.getState().entries.A.isRepo).toBe(false);
  expect(useGitStatusStore.getState().entries.A.error).toBeNull();
});

it("a snapshot supersedes a pending request and other projects stay isolated", async () => {
  let rejectOld!: (error: Error) => void;
  vi.mocked(gitRepoInfo).mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectOld = reject;
      }),
  );
  const old = useGitStatusStore.getState().refresh("A");
  useGitStatusStore
    .getState()
    .setSnapshot({
      generation: 1,
      projectPath: "A",
      isRepo: true,
      branch: info.branchInfo,
      statuses: [],
    });
  rejectOld(new Error("stale"));
  await old;
  expect(useGitStatusStore.getState().entries.A.error).toBeNull();
  expect(useGitStatusStore.getState().entries.B).toBeUndefined();
});
