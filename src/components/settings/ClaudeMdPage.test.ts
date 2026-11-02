import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useAppStore } from "@/store";
import { useAgentInstructionsStore } from "@/store/slices/agentInstructions";
import type { AgentInstructionDocument } from "@/store/types";
import { ClaudeMdPage } from "./ClaudeMdPage";

// 用真实 store 的当前快照验证首次渲染；保持 node 测试环境。
vi.mock("@/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store")>();
  return { ...actual, useAppStore: Object.assign(
    <T>(selector: (state: ReturnType<typeof actual.useAppStore.getState>) => T) => selector(actual.useAppStore.getState()),
    actual.useAppStore,
  ) };
});
vi.mock("@/store/slices/agentInstructions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/slices/agentInstructions")>();
  return { ...actual, useAgentInstructionsStore: Object.assign(
    <T>(selector: (state: ReturnType<typeof actual.useAgentInstructionsStore.getState>) => T) => selector(actual.useAgentInstructionsStore.getState()),
    actual.useAgentInstructionsStore,
  ) };
});
vi.mock("@/components/editors/MonacoTextEditor", () => ({
  default: ({ value }: { value: string }) => createElement("pre", { "data-editor": true }, value),
}));
vi.mock("@/components/markdown/MarkdownPreview", () => ({ default: () => null }));

const projectPath = "E:\\7.project\\test\\Termflow";
const filePath = `${projectPath}\\AGENTS.md`;
const document: AgentInstructionDocument = {
  exists: true, content: "# Existing project instructions", draft: "# Existing project instructions",
  loading: false, saving: false, loaded: true, error: null,
};

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.getState().setCurrentProject({ name: "Termflow", path: projectPath });
  useAgentInstructionsStore.setState(useAgentInstructionsStore.getInitialState(), true);
});

it("renders the existing full-path document instead of an empty missing-file editor", () => {
  useAgentInstructionsStore.setState({ documents: { [filePath]: document } });
  const markup = renderToStaticMarkup(createElement(ClaudeMdPage));
  expect(markup).toContain(document.content);
  expect(markup).toContain(i18n.t("settings.claudeMd.fileExists"));
  expect(markup).not.toContain(i18n.t("settings.claudeMd.fileMissing"));
  expect(markup).not.toContain("common.saved");
});

it("shows a read error without a missing-file message or editable blank document", () => {
  useAgentInstructionsStore.setState({ documents: { [filePath]: { ...document, exists: null, error: "Access denied" } } });
  const markup = renderToStaticMarkup(createElement(ClaudeMdPage));
  expect(markup).toContain("Access denied");
  expect(markup).toContain(i18n.t("settings.claudeMd.loadFailed"));
  expect(markup).not.toContain(i18n.t("settings.claudeMd.fileMissing"));
  expect(markup).not.toContain("data-editor");
});

it("hides another project's cached instructions immediately when switching projects", () => {
  useAgentInstructionsStore.setState({ documents: { [filePath]: document } });
  useAppStore.getState().setCurrentProject({ name: "Other", path: "E:/Other" });
  const markup = renderToStaticMarkup(createElement(ClaudeMdPage));
  expect(markup).not.toContain(document.content);
  expect(markup).not.toContain(i18n.t("settings.claudeMd.fileMissing"));
  expect(markup).not.toContain("data-editor");
});
