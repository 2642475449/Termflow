import { describe, expect, it } from "vitest";
import {
  parseCommitMarkdownCode,
  parseCommitMarkdownHeading,
  parseCommitMarkdownInline,
  parseCommitMarkdownList,
  parseCommitMarkdownQuote,
} from "./gitCommitMarkdown";

describe("parseCommitMarkdownHeading", () => {
  it("reads heading level and text", () => {
    expect(parseCommitMarkdownHeading("### 变更明细")).toEqual({
      level: 3,
      text: "变更明细",
    });
  });

  it("returns null for non heading source", () => {
    expect(parseCommitMarkdownHeading("变更明细：")).toBeNull();
    expect(parseCommitMarkdownHeading("#nospace")).toBeNull();
  });
});

describe("parseCommitMarkdownList", () => {
  it("detects bullet and ordered markers", () => {
    expect(parseCommitMarkdownList("- 新增 `git_abort_operation`\n- 保留兼容命令")).toEqual([
      { text: "新增 `git_abort_operation`", ordered: false },
      { text: "保留兼容命令", ordered: false },
    ]);
    expect(parseCommitMarkdownList("1. 第一步\n2) 第二步")).toEqual([
      { text: "第一步", ordered: true },
      { text: "第二步", ordered: true },
    ]);
  });

  it("merges lazy continuation lines into the previous item", () => {
    expect(parseCommitMarkdownList("- 前端新增状态管理\n并接入中止流程\n- 更新文案")).toEqual([
      { text: "前端新增状态管理 并接入中止流程", ordered: false },
      { text: "更新文案", ordered: false },
    ]);
  });
});

describe("parseCommitMarkdownCode", () => {
  it("strips fences and keeps inner lines", () => {
    expect(parseCommitMarkdownCode("```rust\nlet a = 1;\nlet b = 2;\n```")).toBe(
      "let a = 1;\nlet b = 2;",
    );
  });

  it("tolerates unterminated fences", () => {
    expect(parseCommitMarkdownCode("```\nplain text")).toBe("plain text");
  });
});

describe("parseCommitMarkdownQuote", () => {
  it("removes quote markers per line", () => {
    expect(parseCommitMarkdownQuote("> 第一行\n> 第二行")).toBe("第一行\n第二行");
  });
});

describe("parseCommitMarkdownInline", () => {
  it("splits code, strong, emphasis and strikethrough tokens", () => {
    expect(parseCommitMarkdownInline("新增 `git_commit_sync` **前置校验** ~~旧行为~~")).toEqual([
      { kind: "text", text: "新增 " },
      { kind: "code", text: "git_commit_sync" },
      { kind: "text", text: " " },
      { kind: "strong", text: "前置校验" },
      { kind: "text", text: " " },
      { kind: "del", text: "旧行为" },
    ]);
  });

  it("reads link tokens and auto linked urls", () => {
    expect(parseCommitMarkdownInline("[提交记录](https://example.com/c/1) 参见 www.example.com/x")).toEqual([
      { kind: "link", text: "提交记录", href: "https://example.com/c/1" },
      { kind: "text", text: " 参见 " },
      { kind: "link", text: "www.example.com/x", href: "https://www.example.com/x" },
    ]);
  });

  it("keeps unmatched text as a single token", () => {
    expect(parseCommitMarkdownInline("变更明细：")).toEqual([
      { kind: "text", text: "变更明细：" },
    ]);
    expect(parseCommitMarkdownInline("")).toEqual([]);
  });
});
