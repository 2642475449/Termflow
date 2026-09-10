import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({ gitListBranches: vi.fn() }));
import { gitListBranches } from "@/lib/api";
import { useGitBranchesStore } from "./gitBranches";
import type { GitBranchListItem } from "@/types";

const branch = (name: string): GitBranchListItem => ({
  name,
  isCurrent: true,
  isRemote: false,
  upstream: null,
  ahead: 0,
  behind: 0,
});
beforeEach(() => {
  vi.resetAllMocks();
  useGitBranchesStore.setState({ entries: {} });
});

it("a slow project A response cannot replace project B branches", async () => {
  let resolveA!: (branches: GitBranchListItem[]) => void;
  vi.mocked(gitListBranches).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveA = resolve;
      }),
  );
  const a = useGitBranchesStore.getState().refresh("A");
  vi.mocked(gitListBranches).mockResolvedValue([branch("B-main")]);
  await useGitBranchesStore.getState().refresh("B");
  resolveA([branch("A-main")]);
  await a;
  expect(useGitBranchesStore.getState().entries.B.branches[0].name).toBe(
    "B-main",
  );
  expect(useGitBranchesStore.getState().entries.A.branches[0].name).toBe(
    "A-main",
  );
});

it("ignores superseded requests for the same project and clears stale choices on failure", async () => {
  let resolveOld!: (branches: GitBranchListItem[]) => void;
  vi.mocked(gitListBranches).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const old = useGitBranchesStore.getState().refresh("A");
  vi.mocked(gitListBranches).mockResolvedValue([branch("new")]);
  await useGitBranchesStore.getState().refresh("A");
  resolveOld([branch("old")]);
  await old;
  expect(useGitBranchesStore.getState().entries.A.branches[0].name).toBe("new");
  vi.mocked(gitListBranches).mockRejectedValue(new Error("unreadable"));
  await useGitBranchesStore.getState().refresh("A");
  expect(useGitBranchesStore.getState().entries.A.branches).toEqual([]);
  expect(useGitBranchesStore.getState().entries.A.error).toContain(
    "unreadable",
  );
});
