import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Root } from "hast";
import { parseScheduledTaskLog } from "@/lib/scheduledTasks";
import MarkdownPreview, {
  isLikelyMarkdownPath,
  renderInlineMarkdown,
  renderStarryNightTree,
} from "./MarkdownPreview";

it("renders a saved scheduled-task report as a table, list and code block", () => {
  const { output } = parseScheduledTaskLog("status: succeeded\nexitCode: 0\n\n--- output ---\n**新增功能**\n\n| 功能 | 说明 |\n|---|---|\n| 定时任务 | 代码巡查 |\n\n- 支持每日运行\n\n```sh\ngit status\n```\n\n--- stderr ---\nCLI diagnostics");
  const markup = renderToStaticMarkup(createElement(MarkdownPreview, {
    content: output,
    emptyText: "empty",
    className: "app-scheduled-result",
  }));
  expect(markup).toMatch(/<strong>[\s\S]*?新增功能[\s\S]*?<\/strong>/);
  expect(markup).toMatch(/<table[\s>]/);
  expect(markup).toMatch(/<li[\s>]/);
  expect(markup).toContain("<pre");
  expect(markup).not.toContain("CLI diagnostics");
  expect(markup).not.toContain("exitCode");
});

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

  it("only renders safe Starry Night text and span nodes", () => {
    const markup = renderToStaticMarkup(
      createElement("code", null, renderStarryNightTree({
        type: "root",
        children: [
          {
            type: "element",
            tagName: "span",
            properties: { className: ["pl-k"] },
            children: [{ type: "text", value: "const" }],
          },
          {
            type: "element",
            tagName: "script",
            properties: {},
            children: [{ type: "text", value: "alert(1)" }],
          },
        ],
      } as Root)),
    );

    expect(markup).toContain('<span class="pl-k">const</span>');
    expect(markup).not.toContain("script");
    expect(markup).not.toContain("alert(1)");
  });

  it("uses standard heading anchors so in-document links can navigate", () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        content: "[查看安装](#安装)\n\n## 安装",
        emptyText: "empty",
      }),
    );

    expect(markup).toContain('href="#安装"');
    expect(markup).toContain('<h2 id="安装"');
  });

  it("replaces a TOC directive with links to document headings", () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        content: [
          "[TOC]",
          "",
          "# 概览",
          "## 安装",
          "### Windows",
          "",
          "```md",
          "# 不应出现在目录中",
          "```",
        ].join("\n"),
        emptyText: "empty",
      }),
    );

    expect(markup).toContain('class="app-markdown-toc"');
    expect(markup).toContain('href="#概览"');
    expect(markup).toContain('href="#安装"');
    expect(markup).toContain('href="#windows"');
    expect(markup).toContain('class="app-markdown-toc-level-3"');
    expect(markup).not.toContain("[TOC]");
    expect(markup).not.toContain('href="#不应出现在目录中"');
  });

  it("keeps ordinary content editable by block when footnotes are present", () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        content: [
          "正文先引用[^second]，再引用[^first]。",
          "",
          "[^first]: 第一条脚注",
          "",
          "[^second]: 第二条脚注",
        ].join("\n"),
        emptyText: "empty",
        onEditBlock: () => undefined,
      }),
    );

    expect(markup.match(/class="app-markdown-editable-block"/g)).toHaveLength(2);
    expect(markup).toContain('data-markdown-block-kind="footnotes"');
    expect(markup).toMatch(/href="#markdown-footnote-second"[^>]*>\[1\]/);
    expect(markup).toMatch(/href="#markdown-footnote-first"[^>]*>\[2\]/);
    expect(markup).toContain("第一条脚注");
    expect(markup).toContain("第二条脚注");
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

  it("preserves indentation and markers for nested ordered and unordered lists", () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        content: [
          "- 第一项",
          "",
          "- 第二项",
          "",
          "  - 嵌套子项 A",
          "",
          "  - 嵌套子项 B",
          "",
          "    - 更深层嵌套",
          "",
          "- 第三项",
          "",
          "1. 首先做这件事情",
          "",
          "2. 然后做那件事情",
          "",
          "   1. 子步骤一",
          "",
          "   2. 子步骤二",
          "",
          "3. 最后检查结果",
        ].join("\n"),
        emptyText: "empty",
      }),
    );

    expect(markup.match(/<ul/g)).toHaveLength(3);
    expect(markup.match(/<ol/g)).toHaveLength(2);
    expect(markup).toMatch(/第二项[\s\S]*?<ul[\s\S]*?嵌套子项 A/);
    expect(markup).toMatch(/然后做那件事情[\s\S]*?<ol[\s\S]*?子步骤一/);
    expect(markup).toContain("app-markdown-list--unordered");
    expect(markup).toContain("app-markdown-list--ordered");
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

  it("keeps explicitly middle-aligned README icons inline", () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        content: [
          '<p align="center">',
          '  <code><img src="public/agents/claude.svg" width="16" alt="" align="absmiddle"> Claude Code</code>',
          '  <code><img src="public/agents/codex.svg" width="16" alt="" align="middle"> Codex</code>',
          '</p>',
        ].join("\n"),
        emptyText: "empty",
        filePath: "C:/projects/termflow/README.md",
        projectPath: "C:/projects/termflow",
      }),
    );

    expect(markup).toContain('class="app-html-inline-image"');
    expect(markup.match(/app-html-inline-image/g)).toHaveLength(2);
  });

  it("renders raw line breaks and linked images inside Markdown tables", () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        content: [
          "| 功能 | 预览 |",
          "| --- | --- |",
          '| 文件协作 | 说明<br><br><a href="demo.mp4"><img src="demo.png" alt="演示" width="480"></a> |',
        ].join("\n"),
        emptyText: "empty",
        filePath: "C:/projects/termflow/README.md",
        projectPath: "C:/projects/termflow",
      }),
    );

    expect(markup).toContain("<br>");
    expect(markup).toContain("<img");
    expect(markup).toContain("data-markdown-project-path=");
    expect(markup).not.toContain("&lt;img");
    expect(markup).not.toContain("&lt;br");
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
