import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentActivityIcon } from "./AgentActivityIcon";

describe("AgentActivityIcon", () => {
  it("renders a live permission/input wait as a distinct waiting state", () => {
    const markup = renderToStaticMarkup(
      React.createElement(AgentActivityIcon, {
        agentId: "codex",
        active: true,
        status: "waiting",
      }),
    );
    expect(markup).toContain('data-state="waiting"');
    expect(markup).not.toContain("data-feedback");
  });

  it("keeps completed sessions visually idle without a completion badge", () => {
    const markup = renderToStaticMarkup(
      React.createElement(AgentActivityIcon, {
        agentId: "codex",
        active: true,
        status: "completed",
      }),
    );
    expect(markup).toContain('data-state="idle"');
    expect(markup).not.toContain("app-agent-completion-badge");
    expect(markup).toContain('src="/agents/codex.svg"');
    expect(markup).not.toContain("data-feedback");
  });

  it.each(["starting", "running"] as const)("renders live %s sessions with their activity state", (status) => {
    const markup = renderToStaticMarkup(
      React.createElement(AgentActivityIcon, { agentId: "claude", active: true, status }),
    );
    expect(markup).toContain(`data-state="${status}"`);
    expect(markup).not.toContain("data-feedback");
  });
});
