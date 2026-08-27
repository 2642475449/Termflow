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
  });

  it("keeps completed sessions visually idle", () => {
    const markup = renderToStaticMarkup(
      React.createElement(AgentActivityIcon, {
        agentId: "codex",
        active: true,
        status: "completed",
      }),
    );
    expect(markup).toContain('data-state="idle"');
  });
});
