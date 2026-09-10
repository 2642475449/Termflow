import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  workflow: vi.fn(),
  refresh: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  busy: {} as Record<string, string | null>,
}));
vi.mock("react", () => ({ useCallback: <T>(fn: T) => fn }));
vi.mock("antd", () => ({
  message: {
    warning: mocks.warning,
    error: mocks.error,
    success: mocks.success,
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/api", () => ({
  gitRunWorkflow: mocks.workflow,
  gitCommit: vi.fn(),
  gitCommitAmend: vi.fn(),
  gitPullWithStash: vi.fn(),
}));
vi.mock("@/lib/gitGraphEvents", () => ({
  refreshGitStateAndGraph: mocks.refresh,
}));
vi.mock("@/store/slices/gitRemote", () => {
  const state = {
    busy: mocks.busy,
    setBusy: (path: string, value: string | null) => {
      mocks.busy[path] = value;
    },
    refresh: async () => undefined,
  };
  return {
    useGitRemoteStore: Object.assign(
      (select: (s: typeof state) => unknown) => select(state),
      { getState: () => state },
    ),
  };
});
import { useGitCommit } from "./useGitCommit";

const hook = () =>
  useGitCommit({
    projectPath: "A",
    expectedBranch: "main",
    stagedFiles: [],
    unstagedFiles: [],
    refresh: async () => undefined,
  });
beforeEach(() => {
  vi.clearAllMocks();
  delete mocks.busy.A;
  vi.stubGlobal("window", {});
  mocks.refresh.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

it("sends the entire commit/sync intent with the expected branch in one IPC", async () => {
  mocks.workflow.mockResolvedValue({
    success: true,
    commitOid: "abc",
    failedStage: null,
    message: "",
  });
  await hook().commitAndSync("message");
  expect(mocks.workflow).toHaveBeenCalledExactlyOnceWith({
    projectPath: "A",
    expectedBranch: "main",
    action: "commit-and-sync",
    message: "message",
    files: [],
  });
  expect(mocks.busy.A).toBeNull();
});

it("reports partial success without rejecting a saved commit or requesting another commit", async () => {
  mocks.workflow.mockResolvedValue({
    success: false,
    commitOid: "abc",
    failedStage: "push",
    message: "network failed",
  });
  await expect(hook().commitAndPush("message")).resolves.toBeUndefined();
  expect(mocks.warning).toHaveBeenCalledWith("sidebar.gitCommitRemotePartial");
  expect(mocks.error).not.toHaveBeenCalled();
});

it("keeps the draft on a known commit failure and avoids an unknown-result warning", async () => {
  mocks.workflow.mockResolvedValue({
    success: false,
    commitOid: null,
    failedStage: "commit",
    message: "hook rejected",
  });
  await expect(hook().commitAndPush("message")).rejects.toThrow(
    "hook rejected",
  );
  expect(mocks.error).toHaveBeenCalledTimes(1);
  expect(mocks.busy.A).toBeNull();
});

it("does not misreport an IPC transport failure as a failed commit", async () => {
  mocks.workflow.mockRejectedValue(new Error("IPC disconnected"));
  await expect(hook().commitAndSync("message")).rejects.toThrow(
    "IPC disconnected",
  );
  expect(mocks.error).toHaveBeenCalledWith("sidebar.gitWorkflowUnknown");
});

it("does not turn a completed commit into failure when refreshing the UI fails", async () => {
  mocks.workflow.mockResolvedValue({
    success: true,
    commitOid: "abc",
    failedStage: null,
    message: "",
  });
  mocks.refresh.mockRejectedValue(new Error("refresh failed"));
  await expect(hook().commitAndPush("message")).resolves.toBeUndefined();
  expect(mocks.warning).toHaveBeenCalledWith("sidebar.gitRefreshFailed");
});

it("blocks a second operation while another operation owns the project", async () => {
  mocks.busy.A = "branch";
  await expect(hook().sync()).rejects.toThrow();
  expect(mocks.workflow).not.toHaveBeenCalled();
  expect(mocks.busy.A).toBe("branch");
});
