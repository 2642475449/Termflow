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
});
