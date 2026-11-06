// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FileTreeEntry } from "@/types";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), search: vi.fn(), open: vi.fn(), drag: vi.fn(), rename: vi.fn(),
}));
vi.mock("@/store", () => ({ useAppStore: (select: (state: unknown) => unknown) => select({ setResourceDragState: mocks.drag }) }));
vi.mock("@/lib/api", () => ({
  listProjectDirectory: mocks.list, searchProjectEntries: mocks.search,
  renameProjectEntry: mocks.rename, copyExternalEntry: vi.fn(), copyProjectEntries: vi.fn(),
  createProjectDirectory: vi.fn(), createProjectFile: vi.fn(), deleteProjectEntry: vi.fn(),
  moveProjectEntries: vi.fn(), readClipboardFilePaths: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@/lib/explorer", () => ({ EXPLORER_REVEAL_PATH_EVENT: "reveal", EXPLORER_SELECT_ALL_EVENT: "select-all", takePendingExplorerRevealPath: () => null }));
vi.mock("@/lib/globalSearch", () => ({ openGlobalTextSearch: vi.fn() }));
vi.mock("@/lib/gitGraphEvents", () => ({ dispatchGitFileHistoryOpen: vi.fn() }));
vi.mock("react-i18next", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
import SidebarProjectPanel from "./SidebarProjectPanel";

let root: Root;
let host: HTMLDivElement;
const project = { name: "project", path: "D:/project" };
const entry = (name: string, kind = "file", parent = project.path) => ({ name, kind, path: `${parent}/${name}` }) as FileTreeEntry;
const folder = entry("src", "directory");
const file = entry("package.json");
const child = entry("index.ts", "file", folder.path);
const listing = (path: string, entries: FileTreeEntry[]) => ({ rootPath: project.path, directoryPath: path, entries });
const tree = () => host.querySelector<HTMLElement>('[role="tree"]')!;
const activePath = () => document.getElementById(tree().getAttribute("aria-activedescendant") ?? "")?.querySelector<HTMLElement>("[data-path]")?.dataset.path;
async function press(key: string, options: KeyboardEventInit = {}) {
  await act(async () => { tree().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options })); });
}
async function mount() {
  await act(async () => {
    root.render(React.createElement(SidebarProjectPanel, {
      currentProject: project, noProjectText: "no project", panelTitle: "Project",
      filterPlaceholderText: "Search", filterNoResultsText: "No results", refreshText: "Refresh",
      loadingText: "Loading", emptyFolderText: "Empty", openInManagerText: "Open",
      openInAssociatedAppText: "Open app", copyRelativePathText: "Relative", copyAbsolutePathText: "Absolute",
      copyPathSuccessText: "Copied", onOpenInFileManager: vi.fn(), onOpenInAssociatedApp: vi.fn(), onOpenFile: mocks.open,
    }));
  });
  await act(async () => tree().focus());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.list.mockImplementation(async (_root, path) => listing(path ?? project.path, path ? [child] : [folder, file]));
  mocks.search.mockResolvedValue([]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("navigates visible parent/child rows without opening files and opens only on Enter", async () => {
  await mount();
  expect(activePath()).toBe(folder.path);
  await press("ArrowRight");
  await press("ArrowRight");
  expect(activePath()).toBe(child.path);
  await press("ArrowLeft");
  expect(activePath()).toBe(folder.path);
  await press("ArrowLeft");
  expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(2);
  await press("ArrowDown");
  expect(activePath()).toBe(file.path);
  expect(mocks.open).not.toHaveBeenCalled();
  await press("Enter");
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith(file.path, { preview: false });
  await press("Enter", { repeat: true });
  expect(mocks.open).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(tree());
});

it("extends and shrinks range selection, clamps at the ends, and leaves input keys alone", async () => {
  await mount();
  await press("End", { shiftKey: true });
  expect(host.querySelectorAll('[role="treeitem"][aria-selected="true"]')).toHaveLength(2);
  await press("ArrowUp", { shiftKey: true });
  expect(host.querySelectorAll('[role="treeitem"][aria-selected="true"]')).toHaveLength(1);
  await press("Home");
  await press("ArrowUp");
  expect(activePath()).toBe(folder.path);
  const input = document.createElement("input");
  tree().append(input);
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  expect(activePath()).toBe(folder.path);
  input.remove();
});

it("keeps selection and collapsed state when a slow directory request completes", async () => {
  let resolve!: (value: unknown) => void;
  mocks.list.mockImplementation((_root, path) => path
    ? new Promise((done) => { resolve = done; }) : Promise.resolve(listing(project.path, [folder, file])));
  await mount();
  await press("ArrowRight");
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(host.textContent).not.toContain("Loading");
  await press("ArrowLeft");
  await press("ArrowDown");
  await act(async () => resolve(listing(folder.path, [child])));
  expect(activePath()).toBe(file.path);
  expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(2);
  await press("ArrowUp");
  await press("ArrowRight");
  expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(3);
  expect(mocks.list).toHaveBeenCalledTimes(2);
});

it("never navigates hidden rows while the root listing is loading or failed", async () => {
  let reject!: (error: Error) => void;
  mocks.list.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  await mount();
  await press("ArrowDown");
  await press("Enter");
  expect(tree().hasAttribute("aria-activedescendant")).toBe(false);
  expect(mocks.open).not.toHaveBeenCalled();
  await act(async () => reject(new Error("read failed")));
  await press("Enter");
  expect(tree().hasAttribute("aria-activedescendant")).toBe(false);
  expect(mocks.open).not.toHaveBeenCalled();
});

it("suspends tree keys while its context menu is open and restores focus after an action", async () => {
  await mount();
  const row = host.querySelector<HTMLElement>(".app-file-tree-row")!;
  await act(async () => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  await press("ArrowDown");
  await press("Enter");
  expect(activePath()).toBe(folder.path);
  expect(mocks.open).not.toHaveBeenCalled();
  const copy = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .find((item) => item.textContent === "common.copy")!;
  expect(copy).toBeDefined();
  await act(async () => copy.click());
  expect(document.activeElement).toBe(tree());
  await press("ArrowDown");
  expect(activePath()).toBe(file.path);
});

it("resumes keyboard navigation after refreshing away an open context menu", async () => {
  await mount();
  const row = host.querySelector<HTMLElement>(".app-file-tree-row")!;
  await act(async () => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  const refresh = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.querySelector(".anticon-reload"))!;
  await act(async () => refresh.click());
  await act(async () => tree().focus());
  await press("End");
  expect(activePath()).toBe(file.path);
});
