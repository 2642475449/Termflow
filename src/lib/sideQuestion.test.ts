import { describe, expect, it } from "vitest";
import {
  SIDE_QUESTION_PRESETS,
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

    expect(canSubmitSideQuestion("为什么失败？", selection)).toBe(true);
    expect(canSubmitSideQuestion("   ", selection)).toBe(false);
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
});
