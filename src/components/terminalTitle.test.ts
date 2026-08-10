import { describe, expect, it } from "vitest";
import {
  consumeTerminalTitleInput,
  looksLikeInvalidAutoTitle,
  sanitizeSessionTitle,
  stripSessionTitlePrefix,
} from "./terminalTitle";

describe("terminalTitle", () => {
  it("strips common spoken prefixes", () => {
    expect(stripSessionTitlePrefix("请帮我修复登录问题")).toBe("修复登录问题");
    expect(stripSessionTitlePrefix("会话标题: 修复登录问题")).toBe("修复登录问题");
  });

  it("sanitizes fallback titles from first prompt", () => {
    expect(sanitizeSessionTitle("帮我看看我的系统有什么 bug")).toBe("看看我的系统有什么 bug");
    expect(sanitizeSessionTitle("第一行\n第二行")).toBe("第一行");
  });

  it("sanitizes ai result titles and keeps only the first line", () => {
    expect(sanitizeSessionTitle("Title: Login Feature", true)).toBe("Login Feature");
    expect(sanitizeSessionTitle("第一行标题\n第二行解释", true)).toBe("第一行标题");
  });

  it("rejects title-generation meta text", () => {
    expect(sanitizeSessionTitle("会话标题 会话标题生成请求", true)).toBeNull();
    expect(sanitizeSessionTitle("Session Title title generation request", true)).toBeNull();
  });

  it("rejects noisy repeated single-character titles", () => {
    expect(sanitizeSessionTitle("o o o o o")).toBeNull();
    expect(looksLikeInvalidAutoTitle("o o o o o")).toBe(true);
  });

  it("keeps normal titles", () => {
    expect(looksLikeInvalidAutoTitle("看看系统里有什么 bug")).toBe(false);
    expect(sanitizeSessionTitle("看看系统里有什么 bug")).toBe("看看系统里有什么 bug");
  });

  it("removes CSI ANSI escape sequences", () => {
    expect(sanitizeSessionTitle("\x1b[31m红色文字\x1b[0m标题")).toBe("红色文字 标题");
  });

  it("removes SS3 ANSI escape sequences", () => {
    expect(sanitizeSessionTitle("\x1bOO测试标题")).toBe("测试标题");
  });

  it("removes mixed ANSI sequences", () => {
    expect(sanitizeSessionTitle("\x1b[1m\x1bO粗体\x1b[0m标题")).toBe("粗体 标题");
  });

  it("ignores VT cursor key sequences while capturing terminal input", () => {
    expect(consumeTerminalTitleInput("", "\x1bOI排查会话标题")).toEqual({
      nextValue: "排查会话标题",
      pendingSequence: "",
      shouldCommit: false,
    });
    expect(consumeTerminalTitleInput("", "\x1b[A修复标签异常")).toEqual({
      nextValue: "修复标签异常",
      pendingSequence: "",
      shouldCommit: false,
    });
  });

  it("buffers incomplete escape sequences across input chunks", () => {
    const firstChunk = consumeTerminalTitleInput("", "\x1bO");
    expect(firstChunk).toEqual({
      nextValue: "",
      pendingSequence: "\x1bO",
      shouldCommit: false,
    });

    expect(consumeTerminalTitleInput(firstChunk.nextValue, "I优雅修复", firstChunk.pendingSequence)).toEqual({
      nextValue: "优雅修复",
      pendingSequence: "",
      shouldCommit: false,
    });
  });

  it("keeps edits and detects submit while capturing terminal input", () => {
    expect(consumeTerminalTitleInput("登录错", "\b误\r")).toEqual({
      nextValue: "登录误",
      pendingSequence: "",
      shouldCommit: true,
    });
  });
});
