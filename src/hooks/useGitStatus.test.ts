// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({ gitRepoInfo: vi.fn(), gitStatus: vi.fn(), gitFetch: vi.fn(), gitRemoteState: vi.fn() }));
import { gitRepoInfo, gitStatus, gitFetch } from "@/lib/api";
import { useGitStatus } from "./useGitStatus";
import { useGitStatusStore } from "@/store/slices/gitStatus";
import { useGitRemoteStore } from "@/store/slices/gitRemote";
let root: Root;
let host: HTMLDivElement;
let refresh: () => Promise<void>;
function Probe() {
  refresh = useGitStatus({ currentProject: { name: "test", path: "/repo" } }).refresh;
  return null;
}
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  vi.mocked(gitRepoInfo).mockResolvedValue({ isRepo: true, branchInfo: null });
  vi.mocked(gitStatus).mockResolvedValue([]);
  useGitStatusStore.setState({ entries: {} });
  useGitRemoteStore.setState({ fetchErrors: { "/repo": "offline" } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
it("mount and manual local refresh never fetch and remain usable after a remote failure", async () => {
  await act(async () => root.render(createElement(Probe)));
  expect(gitStatus).toHaveBeenCalledTimes(1);
  await act(async () => { await refresh(); });
  expect(gitStatus).toHaveBeenCalledTimes(2);
  expect(gitFetch).not.toHaveBeenCalled();
  expect(useGitStatusStore.getState().entries["/repo"].error).toBeNull();
  expect(useGitRemoteStore.getState().fetchErrors["/repo"]).toBe("offline");
});
