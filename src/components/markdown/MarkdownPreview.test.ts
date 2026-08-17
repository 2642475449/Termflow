import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MarkdownPreview, {
  isLikelyMarkdownPath,
  renderInlineMarkdown,
} from "./MarkdownPreview";

describe("isLikelyMarkdownPath", () => {
  it("recognizes absolute and relative project paths", () => {
    expect(isLikelyMarkdownPath(String.raw`D:\3.project\Termflow\src\locales`)).toBe(true);
    expect(isLikelyMarkdownPath("src/components/")).toBe(true);
    expect(isLikelyMarkdownPath("../package.json")).toBe(true);
    expect(isLikelyMarkdownPath(".")).toBe(true);
  });

  it("does not turn ordinary inline code into links", () => {
    expect(isLikelyMarkdownPath("useMemo")).toBe(false);
    expect(isLikelyMarkdownPath("npm run build")).toBe(false);
    expect(isLikelyMarkdownPath("--dangerously-skip-permissions")).toBe(false);
  });

  it("exposes independently editable blocks when editing is enabled", () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        content: "# Title\n\nParagraph\n\n- one\n- two",
        emptyText: "empty",
        editBlockLabel: "Edit block",
        onEditBlock: () => undefined,
      }),
    );

    expect(markup.match(/class="app-markdown-editable-block"/g)).toHaveLength(3);
    expect(markup.match(/aria-label="Edit block"/g)).toHaveLength(3);
    expect(markup).toContain('data-markdown-block-kind="heading"');
    expect(markup).toContain('data-markdown-block-kind="list"');
  });
});

describe("Markdown rendering", () => {
  it("renders common inline emphasis", () => {
    const markup = renderToStaticMarkup(
      renderInlineMarkdown("**Termflow** is *fast* and ~~old~~", { keyPrefix: "inline" }),
    );

    expect(markup).toContain("<strong><span>Termflow</span></strong>");
    expect(markup).toContain("<em>fast</em>");
    expect(markup).toContain("<del");
  });

  it("renders thematic breaks and fenced code copy controls", () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        content: "before\n\n---\n\n```ts\nconst ready = true;\n```",
        emptyText: "empty",
      }),
    );

    expect(markup).toContain("<hr/>");
    expect(markup).toContain("const ready = true;");
    expect(markup).toContain('aria-label="复制代码"');
  });

  it("renders compact two-dash table separators", () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        content: "| 功能说明 | 界面预览 |\n| :-- | :-- |\n| 多会话管理 | 预览图 |",
        emptyText: "empty",
      }),
    );

    expect(markup).toContain("<table");
    expect(markup).toContain("多会话管理");
    expect(markup).not.toContain("| :-- | :-- |");
  });

  it("keeps multiline HTML headers together so README links render as links", () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        content: [
          '<h1 align="center">',
          '  <img src="public/logo.png" width="56" alt="Termflow Logo">',
          '  Termflow',
          '</h1>',
          '',
          '<p align="center">',
          '  简体中文 | <a href="README.en-US.md">English</a>',
          '</p>',
        ].join("\n"),
        emptyText: "empty",
        filePath: "C:/projects/termflow/README.md",
        projectPath: "C:/projects/termflow",
      }),
    );

    expect(markup).toMatch(/<h1[^>]*>[\s\S]*Termflow[\s\S]*<\/h1>/);
    expect(markup).toContain("<a href=");
    expect(markup).not.toContain("&lt;a href=");
  });

  it("filters executable content from raw HTML blocks", () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        content: '<p onclick="alert(1)">safe<script>alert(2)</script></p>',
        emptyText: "empty",
      }),
    );

    expect(markup).toContain("safe");
    expect(markup).not.toContain("onclick");
    expect(markup).not.toContain("script");
    expect(markup).not.toContain("alert");
  });
});
