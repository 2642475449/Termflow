import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { McpServersView } from "./McpServersView";

function renderView(overrides: Partial<ComponentProps<typeof McpServersView>> = {}) {
  const noop = () => {};
  return renderToStaticMarkup(createElement(McpServersView, {
    agents: ["antigravity"],
    agent: "antigravity",
    scope: "workspace",
    servers: [],
    filteredServers: [],
    projectName: "Termflow",
    search: "",
    loading: false,
    refreshing: false,
    available: false,
    testingKey: null,
    testResult: null,
    onAgent: noop,
    onScope: noop,
    onSearch: noop,
    onRefresh: noop,
    onAdd: noop,
    onEdit: noop,
    onDelete: noop,
    onTest: noop,
    onOpenConfig: noop,
    ...overrides,
  }));
}

describe("McpServersView", () => {
  it.each(["workspace", "user"] as const)("does not claim a project is missing after a %s catalog failure", (scope) => {
    const markup = renderView({ scope });
    expect(markup).toContain(i18n.t("settings.mcpServers.loadFailed"));
    expect(markup).not.toContain(i18n.t("settings.mcpServers.workspaceConfigUnavailable"));
  });

  it("shows the project hint when no project is open", () => {
    const markup = renderView({ projectName: undefined, available: true });
    expect(markup).toContain(i18n.t("settings.mcpServers.workspaceConfigUnavailable"));
  });
});
