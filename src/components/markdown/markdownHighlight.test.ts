import { describe, expect, it } from "vitest";
import type { Root, RootContent, ElementContent } from "hast";
import { highlightWithMarkdownCode } from "./markdownHighlight";
import { getTextmateHighlighter } from "@/lib/textmate";
import {
  MARKDOWN_CODE_MAX_CODE_CHARS,
  MARKDOWN_CODE_MAX_CODE_LINES,
  canHighlightWithMarkdownCode,
  getMarkdownCodeLanguageFlag,
} from "./markdownHighlightEligibility";

describe("Markdown code highlighting", () => {
  it("uses the first fenced-code language token", () => {
    expect(getMarkdownCodeLanguageFlag(" TypeScript {1,3} ")).toBe("typescript");
    expect(getMarkdownCodeLanguageFlag("  ")).toBeNull();
    expect(getMarkdownCodeLanguageFlag()).toBeNull();
  });

  it("avoids highlighting oversized code blocks", () => {
    expect(canHighlightWithMarkdownCode("const ready = true;")).toBe(true);
    expect(canHighlightWithMarkdownCode("x".repeat(MARKDOWN_CODE_MAX_CODE_CHARS + 1))).toBe(false);
    expect(canHighlightWithMarkdownCode("\n".repeat(MARKDOWN_CODE_MAX_CODE_LINES))).toBe(false);
  });
});

function plainText(node: Root | RootContent | ElementContent): string {
  if (node.type === "text") return node.value;
  return "children" in node ? node.children.map(plainText).join("") : "";
}

it("shares the editor highlighter instance across concurrent callers", async () => {
  const first = getTextmateHighlighter();
  expect(getTextmateHighlighter()).toBe(first);
  await highlightWithMarkdownCode("const x = 1;", "ts");
  expect(await getTextmateHighlighter()).toBe(await first);
});

it.each(["ts", "typescript", "tsx", "js", "jsx", "json", "html", "css", "cs", "c#", "csharp", "diff", "patch", "bash", "sh", "shell", "powershell", "py", "python", "rust", "go", "java", "c", "cpp", "sql", "toml", "yaml", "md", "dockerfile"])("retains Markdown language support for %s", async (language) => {
  expect(await highlightWithMarkdownCode("sample", language)).not.toBeNull();
});

it.each(["", "\n", "  a\r\n\r\nb\n", '<script>alert("中文😀")</script>\n', "/* start\ncomment\n*/ const x = 1;"])("preserves source text exactly: %j", async (code) => {
  const tree = await highlightWithMarkdownCode(code, "ts");
  expect(tree).not.toBeNull();
  expect(plainText(tree!)).toBe(code);
});

it("carries multiline state and emits theme-aware semantic classes", async () => {
  const tree = await highlightWithMarkdownCode("/* start\ninside\n*/ const x = 1;", "ts");
  const spans = tree!.children.filter((node) => node.type === "element");
  expect(spans.find((node) => plainText(node) === "inside")?.properties.className).toEqual(["app-code-comment"]);
  expect(spans.some((node) => node.properties.className?.toString() === "app-code-keyword")).toBe(true);
});

it("distinguishes additions and removals in diffs", async () => {
  const tree = await highlightWithMarkdownCode("-old\n+new", "diff");
  expect(JSON.stringify(tree)).toContain("app-code-deleted");
  expect(JSON.stringify(tree)).toContain("app-code-inserted");
});

it("falls back for unknown languages and oversized input", async () => {
  expect(await highlightWithMarkdownCode("hello", "unknown-language")).toBeNull();
  expect(await highlightWithMarkdownCode("hello")).toBeNull();
  expect(await highlightWithMarkdownCode("x".repeat(30_001), "ts")).toBeNull();
});
