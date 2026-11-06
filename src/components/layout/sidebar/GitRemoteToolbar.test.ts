// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const ui = vi.hoisted(() => ({ menu: null as any, error: vi.fn(), success: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("antd", () => ({
  Dropdown: ({ children, menu }: { children: ReactNode; menu: unknown }) => { ui.menu = menu; return children; },
  Modal: ({ open, children }: { open: boolean; children: ReactNode }) => open ? createElement("div", { role: "dialog" }, children) : null,
  Input: () => null, Select: () => null,
  message: { error: ui.error, success: ui.success, warning: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ gitFetch: vi.fn(), gitRemoteState: vi.fn(), gitRepoInfo: vi.fn(), gitStatus: vi.fn(), gitPublishBranch: vi.fn(), gitSaveRemote: vi.fn(), gitSetUpstream: vi.fn() }));
import { gitFetch, gitRemoteState } from "@/lib/api";
import { useGitRemoteStore } from "@/store/slices/gitRemote";
import { GitRemoteToolbar } from "./GitRemoteToolbar";
let root: Root;
let host: HTMLDivElement;
const state = { remotes: [{ name: "origin", url: "https://example.com/repo" }], upstream: null, hasCommit: true, branchName: "main", branches: [], requiresFetch: false };
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  vi.mocked(gitRemoteState).mockResolvedValue(state);
  useGitRemoteStore.setState({ entries: { "/repo": { data: state, error: null } }, busy: {}, fetching: {}, fetchErrors: { "/repo": "old failure" } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
it("keeps fetch in the overflow menu and opens failure details only on request", async () => {
  await act(async () => root.render(createElement(GitRemoteToolbar, { projectPath: "/repo", branch: null, disabled: false, refresh: vi.fn(), menuItems: [], onMenuClick: vi.fn() })));
  expect(host.querySelectorAll("button")).toHaveLength(1);
  expect(host.textContent).not.toContain("old failure");
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(ui.menu.items.find((item: any) => item.key === "remote-fetch").disabled).toBe(false);
  vi.mocked(gitFetch).mockResolvedValue({ success: false, message: "proxy unavailable" });
  await act(async () => { ui.menu.onClick({ key: "remote-fetch" }); });
  expect(gitFetch).toHaveBeenCalledWith("/repo");
  expect(ui.error).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => { ui.menu.onClick({ key: "remote-error" }); });
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain("proxy unavailable");
});
