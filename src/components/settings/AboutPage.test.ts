import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import "@/i18n";
import packageJson from "../../../package.json";
import { AboutPage } from "./AboutPage";

describe("AboutPage", () => {
  it("renders the hero banner with current version and branding", () => {
    const markup = renderToStaticMarkup(React.createElement(AboutPage));
    expect(markup).toContain("Termflow");
    expect(markup).toContain(`v${packageJson.version}`);
    expect(markup).toContain('alt="Termflow"');
    expect(markup).not.toContain("不是另一个智能体");
    expect(markup).toContain("Termflow 是为本地 AI 编程智能体打造的统一工作台");
  });

  it("removes internal tech stack section completely", () => {
    const markup = renderToStaticMarkup(React.createElement(AboutPage));
    // Verify removed tech stack internal details
    expect(markup).not.toContain("Tauri 2 + React 19");
    expect(markup).not.toContain("xterm.js + ConPTY");
    expect(markup).not.toContain("Zustand + persist");
  });

  it("renders open source licensing, copyright, and application ID", () => {
    const markup = renderToStaticMarkup(React.createElement(AboutPage));
    expect(markup).toContain("MIT License");
    expect(markup).toContain("2026");
    expect(markup).toContain("com.termflow.desktop");
  });

  it("renders navigation action when onNavigate is provided", () => {
    const markup = renderToStaticMarkup(React.createElement(AboutPage, { onNavigate: () => {} }));
    expect(markup).toContain("ant-btn");
  });
});
