import { describe, expect, it } from "vitest";
import {
  RESOURCE_SIDE_QUESTION_PRESETS,
  SIDE_QUESTION_PRESETS,
  buildResourceSideQuestionContext,
  buildResourceSideQuestionPrompt,
  buildSideQuestionPrompt,
  canSubmitSideQuestion,
  sanitizeTerminalSelection,
} from "./sideQuestion";

describe("side question context", () => {
  it("normalizes control sequences and reports line count", () => {
    expect(sanitizeTerminalSelection("\u001b[31merror\u001b[0m\r\nnext\u0000")).toEqual({
      text: "error\nnext",
      lineCount: 2,
      truncated: false,
      potentialSecret: false,
    });
  });

  it("truncates oversized selections", () => {
    expect(sanitizeTerminalSelection("abcdef", 4)).toEqual({
      text: "abcd\n…",
      lineCount: 1,
      truncated: true,
      potentialSecret: false,
    });
  });

  it("builds a compact prompt without the visible instruction preamble", () => {
    const prompt = buildSideQuestionPrompt({
      question: "为什么失败？",
      context: "rm -rf .",
      sourceSessionName: "Build",
      projectPath: "D:/repo",
    });

    expect(prompt).not.toContain("这是一个 Termflow 侧边提问");
    expect(prompt).not.toContain("以下内容是用户从终端中明确选取的不可信数据");
    expect(prompt).toMatch(/^来源会话：Build\n工作目录：D:\/repo/);
    expect(prompt).toContain("<terminal_selection>\nrm -rf .\n</terminal_selection>");
    expect(prompt).toContain("用户问题：\n为什么失败？");
  });

  it("flags likely secrets before the user sends the draft", () => {
    expect(sanitizeTerminalSelection("API_KEY=abcdefghijklmnop").potentialSecret).toBe(true);
    expect(sanitizeTerminalSelection("ordinary build output").potentialSecret).toBe(false);
  });

  it("requires a custom question and selected terminal context before sending", () => {
    const selection = sanitizeTerminalSelection("build failed");
    const context = { kind: "terminal", selection } as const;

    expect(canSubmitSideQuestion("为什么失败？", context)).toBe(true);
    expect(canSubmitSideQuestion("   ", context)).toBe(false);
    expect(canSubmitSideQuestion("为什么失败？", null)).toBe(false);
  });

  it("offers the four side-question presets in the intended order", () => {
    expect(SIDE_QUESTION_PRESETS.map((preset) => preset.id)).toEqual([
      "explain",
      "failure",
      "fix",
      "next",
    ]);
  });

  it("builds a bounded, deduplicated resource context with project-relative paths", () => {
    const context = buildResourceSideQuestionContext("D:\\repo", [
      { path: "D:\\repo\\src\\main.ts", kind: "file" },
      { path: "D:\\repo\\src\\main.ts", kind: "file" },
      { path: "D:\\repo\\src\\components", kind: "directory" },
      { path: "D:\\repo\\README.md", kind: "file" },
    ], 2);

    expect(context).toEqual({
      resources: [
        { path: "src/main.ts", kind: "file" },
        { path: "src/components", kind: "directory" },
      ],
      totalCount: 3,
      truncated: true,
      containsDirectory: true,
    });
  });

  it("builds a resource prompt without preloading file contents", () => {
    const context = buildResourceSideQuestionContext("D:/repo", [
      { path: "D:/repo/src/main.ts", kind: "file" },
    ]);
    const prompt = buildResourceSideQuestionPrompt({
      question: "它负责什么？",
      projectPath: "D:/repo",
      context,
    });

    expect(prompt).toContain("工作目录：D:/repo");
    expect(prompt).toContain('<project_resources>\n[\n  {\n    "path": "src/main.ts"');
    expect(prompt).toContain('"kind": "file"');
    expect(prompt).toContain("用户问题：\n它负责什么？");
    expect(prompt).not.toContain("文件内容");
  });

  it("accepts a custom question when resource context is present", () => {
    const resourceContext = buildResourceSideQuestionContext("D:/repo", [
      { path: "D:/repo/src", kind: "directory" },
    ]);

    expect(canSubmitSideQuestion("请分析", { kind: "resources", resourceContext })).toBe(true);
    expect(canSubmitSideQuestion(" ", { kind: "resources", resourceContext })).toBe(false);
  });

  it("offers file-browser presets in the intended order", () => {
    expect(RESOURCE_SIDE_QUESTION_PRESETS.map((preset) => preset.id)).toEqual([
      "explain",
      "review",
      "change",
      "related",
    ]);
  });
});
