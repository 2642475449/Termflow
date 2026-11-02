import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useAppStore } from "@/store";
import { useProjectQuickCommandsStore } from "@/store/slices/projectQuickCommands";
import type { TerminalQuickCommand } from "@/types";
import { QuickCommandsPage } from "./QuickCommandsPage";

// SSR 默认读取初始快照；这里用真实 store 的当前状态验证项目隔离，不依赖 DOM。
vi.mock("@/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store")>();
  return { ...actual, useAppStore: Object.assign(
    <T>(selector: (state: ReturnType<typeof actual.useAppStore.getState>) => T) => selector(actual.useAppStore.getState()),
    actual.useAppStore,
  ) };
});
vi.mock("@/store/slices/projectQuickCommands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/slices/projectQuickCommands")>();
  return { ...actual, useProjectQuickCommandsStore: Object.assign(
    <T>(selector: (state: ReturnType<typeof actual.useProjectQuickCommandsStore.getState>) => T) => selector(actual.useProjectQuickCommandsStore.getState()),
    actual.useProjectQuickCommandsStore,
  ) };
});

const currentCommand: TerminalQuickCommand = {
  id: "current", label: "Current folder build", action: "terminal-command", command: "pnpm build",
  appendEnter: true, scope: { type: "repository", repositoryId: "E:/Current" },
};
const otherCommand: TerminalQuickCommand = {
  ...currentCommand, id: "other", label: "Private other folder command", command: "other-secret-command",
  scope: { type: "repository", repositoryId: "E:/Other" },
};

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.getState().setCurrentProject({ name: "Current", path: "E:/Current" });
  useAppStore.getState().setTerminalQuickCommands([currentCommand, otherCommand]);
  useProjectQuickCommandsStore.setState({ ...useProjectQuickCommandsStore.getInitialState(), loadedProjectPath: "E:/Current" }, true);
});

it("renders only current-folder commands and removes the all-projects selector", () => {
  const markup = renderToStaticMarkup(createElement(QuickCommandsPage));
  expect(markup).toContain(currentCommand.label);
  expect(markup).not.toContain(otherCommand.label);
  expect(markup).not.toContain(otherCommand.command);
  expect(markup).not.toContain(otherCommand.scope.repositoryId);
  expect(markup).not.toContain(i18n.t("quickCommands.filterAll"));
});

it("hides the old folder's cached commands and errors on the first render after switching", () => {
  useAppStore.getState().setCurrentProject({ name: "Other", path: "E:/Other" });
  useProjectQuickCommandsStore.setState({ error: "Current-folder-only error" });
  const markup = renderToStaticMarkup(createElement(QuickCommandsPage));
  expect(markup).not.toContain(currentCommand.label);
  expect(markup).not.toContain("Current-folder-only error");
});

it("shows the current folder's read error without claiming the file is empty", () => {
  useAppStore.getState().setTerminalQuickCommands([]);
  useProjectQuickCommandsStore.setState({ error: "Invalid project file" });
  const markup = renderToStaticMarkup(createElement(QuickCommandsPage));
  expect(markup).toContain("Invalid project file");
  expect(markup).not.toContain(i18n.t("quickCommands.noProjectCommands"));
});

it("shows no cached commands or old errors when no folder is open", () => {
  useAppStore.setState({ currentProject: null });
  useProjectQuickCommandsStore.setState({ error: "Old project read error" });
  const markup = renderToStaticMarkup(createElement(QuickCommandsPage));
  expect(markup).toContain(i18n.t("quickCommands.selectProjectToAdd"));
  expect(markup).not.toContain(currentCommand.label);
  expect(markup).not.toContain(otherCommand.label);
  expect(markup).not.toContain("Old project read error");
});
