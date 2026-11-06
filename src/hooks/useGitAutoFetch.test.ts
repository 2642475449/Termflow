// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({ gitRepoInfo: vi.fn(), gitRemoteState: vi.fn(), gitFetch: vi.fn(), gitStatus: vi.fn() }));
import { gitRepoInfo, gitRemoteState, gitFetch, gitStatus } from "@/lib/api";
import { useAppStore } from "@/store";
import { useGitRemoteStore } from "@/store/slices/gitRemote";
import { useGitAutoFetch } from "./useGitAutoFetch";
let root: Root;
let host: HTMLDivElement;
function Probe({ path = "/auto" }: { path?: string }) { useGitAutoFetch(path); return null; }
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  useAppStore.setState({ gitAutoFetch: false, gitAutoFetchIntervalMinutes: 5 });
  useGitRemoteStore.setState({ entries: {}, busy: {}, fetching: {}, fetchedAt: {}, attemptedAt: {}, fetchErrors: {}, fetchFailures: {} });
  vi.mocked(gitRepoInfo).mockResolvedValue({ isRepo: true, branchInfo: null });
  vi.mocked(gitStatus).mockResolvedValue([]);
  vi.mocked(gitRemoteState).mockResolvedValue({ remotes: [{ name: "origin", url: "https://example.com/repo" }], hasCommit: true, branchName: "main", branches: [], upstream: "origin/main", requiresFetch: false });
  vi.mocked(gitFetch).mockResolvedValue({ success: true, message: "ok" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
it("does not fetch until opted in and honors the selected interval", async () => {
  await act(async () => root.render(createElement(Probe)));
  expect(gitFetch).not.toHaveBeenCalled();
  await act(async () => useAppStore.getState().setGitAutoFetch(true, 3));
  expect(gitFetch).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(gitFetch).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(gitFetch).toHaveBeenCalledTimes(2);
  await act(async () => useAppStore.getState().setGitAutoFetch(false));
  await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
  expect(gitFetch).toHaveBeenCalledTimes(2);
});
it("does not fetch a repository without remotes", async () => {
  vi.mocked(gitRemoteState).mockResolvedValue({ remotes: [], hasCommit: false, branchName: "main", branches: [], upstream: null, requiresFetch: false });
  useAppStore.getState().setGitAutoFetch(true);
  await act(async () => root.render(createElement(Probe)));
  expect(gitFetch).not.toHaveBeenCalled();
});
it("drops an obsolete project probe before starting its network request", async () => {
  let resolveOld!: (info: { isRepo: boolean; branchInfo: null }) => void;
  vi.mocked(gitRepoInfo).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  useAppStore.getState().setGitAutoFetch(true);
  await act(async () => root.render(createElement(Probe, { path: "/old" })));
  await act(async () => root.render(createElement(Probe, { path: "/new" })));
  await act(async () => { resolveOld({ isRepo: true, branchInfo: null }); });
  expect(gitFetch).toHaveBeenCalledTimes(1);
  expect(gitFetch).toHaveBeenCalledWith("/new");
});
