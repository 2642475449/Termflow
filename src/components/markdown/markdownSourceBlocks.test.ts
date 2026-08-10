import { describe, expect, it } from "vitest";
import { getMarkdownSourceBlocks, replaceMarkdownSourceBlock } from "./markdownSourceBlocks";

describe("getMarkdownSourceBlocks", () => {
  it("keeps exact ranges for common Markdown blocks", () => {
    const content = [
      "# Title",
      "",
      "First line",
      "second line",
      "",
      "- one",
      "- two",
      "",
      "```ts",
      "const ready = true;",
      "```",
    ].join("\r\n");

    const blocks = getMarkdownSourceBlocks(content);

    expect(blocks.map((block) => block.kind)).toEqual(["heading", "paragraph", "list", "code"]);
    expect(blocks.map((block) => block.source)).toEqual([
      "# Title",
      "First line\r\nsecond line",
      "- one\r\n- two",
      "```ts\r\nconst ready = true;\r\n```",
    ]);
    for (const block of blocks) {
      expect(content.slice(block.start, block.end)).toBe(block.source);
    }
  });

  it("groups tables and keeps adjacent headings separate", () => {
    const content = "## A\n### B\n\n| A | B |\n|---|:---:|\n| 1 | 2 |";
    const blocks = getMarkdownSourceBlocks(content);

    expect(blocks.map((block) => block.kind)).toEqual(["heading", "heading", "table"]);
  });
});

describe("replaceMarkdownSourceBlock", () => {
  it("only replaces the selected source range", () => {
    const content = "# Before\n\nText\n\n# After";
    const block = getMarkdownSourceBlocks(content)[1];

    expect(replaceMarkdownSourceBlock(content, block, "Changed\ncontent")).toBe(
      "# Before\n\nChanged\ncontent\n\n# After",
    );
  });
});
