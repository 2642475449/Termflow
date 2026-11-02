import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { useAppStore } from "@/store";
import { useQuickCommandUsageStore } from "@/store/slices/quickCommandUsage";
import type { TerminalQuickCommand } from "@/types";
import { QuickCommandsButton } from "./QuickCommandsButton";

vi.mock("@/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store")>();
  return { ...actual, useAppStore: Object.assign(
    <T>(selector: (state: ReturnType<typeof actual.useAppStore.getState>) => T) => selector(actual.useAppStore.getState()),
    actual.useAppStore,
  ) };
});
vi.mock("@/store/slices/quickCommandUsage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/slices/quickCommandUsage")>();
  return { ...actual, useQuickCommandUsageStore: Object.assign(
    <T>(selector: (state: ReturnType<typeof actual.useQuickCommandUsageStore.getState>) => T) => selector(actual.useQuickCommandUsageStore.getState()),
    actual.useQuickCommandUsageStore,
  ) };
});
// 将 Popover 内容直接渲染到静态结果，用 node 环境验证按钮和列表使用同一排序。
vi.mock("antd", async (importOriginal) => ({
  ...await importOriginal<typeof import("antd")>(),
  Popover: ({ children, content }: { children: ReactNode; content: ReactNode }) => createElement("div", null, children, content),
}));
vi.mock("./QuickCommandDialog", () => ({ QuickCommandDialog: () => null }));

const path = "E:/project";
const preview: TerminalQuickCommand = {
  id: "preview", label: "Preview command", command: "pnpm tauri dev", action: "terminal-command", appendEnter: true,
  scope: { type: "repository", repositoryId: path },
};
const build: TerminalQuickCommand = { ...preview, id: "build", label: "Build command", command: "pnpm tauri build" };

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.getState().setCurrentProject({ path, name: "Project" });
  useAppStore.getState().setTerminalQuickCommands([preview, build]);
  useQuickCommandUsageStore.setState({ usageByProject: {} });
});

it("shows the last used command as both the main action and the first menu item", () => {
  useQuickCommandUsageStore.getState().setProjectUsage(path, { preview: 100, build: 200 });
  const markup = renderToStaticMarkup(createElement(QuickCommandsButton));
  const [main, ...items] = markup.split("data-qc-item=");
  expect(main).toContain(build.label);
  expect(main).not.toContain(preview.label);
  expect(items[0]).toContain(build.label);
  expect(items[1]).toContain(preview.label);
});

it("falls back to the first available command after the most recent one is deleted", () => {
  useQuickCommandUsageStore.getState().setProjectUsage(path, { preview: 100, build: 200 });
  useAppStore.getState().setTerminalQuickCommands([preview]);
  const markup = renderToStaticMarkup(createElement(QuickCommandsButton));
  expect(markup).toContain(preview.label);
  expect(markup).not.toContain(build.label);
});

it("uses each project's own history and preserves configuration order without history", () => {
  useQuickCommandUsageStore.getState().setProjectUsage("E:/other", { build: 300 });
  const markup = renderToStaticMarkup(createElement(QuickCommandsButton));
  const [main, ...items] = markup.split("data-qc-item=");
  expect(main).toContain(preview.label);
  expect(main).not.toContain(build.label);
  expect(items[0]).toContain(preview.label);
});
