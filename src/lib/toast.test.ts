import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  createToastArgs,
  guardToastText,
  TOAST_NOTIFICATION_CONFIG,
  TOAST_TEXT_LIMIT,
  truncateToastText,
} from "./toast";

describe("toast policy", () => {
  it("uses one bottom-right stack with at most three notifications", () => {
    expect(TOAST_NOTIFICATION_CONFIG).toMatchObject({
      placement: "bottomRight",
      bottom: 20,
      maxCount: 3,
      stack: { threshold: 3 },
    });
  });

  it("auto-dismisses errors using the shared default duration", () => {
    expect(createToastArgs("error", {
      title: "无法恢复 Codex 会话",
      content: "未找到对应的会话 ID，请新建会话或重试。",
    })).toMatchObject({
      message: "无法恢复 Codex 会话",
      description: "未找到对应的会话 ID，请新建会话或重试。",
      placement: "bottomRight",
      duration: 8,
      pauseOnHover: true,
      showProgress: true,
      role: "alert",
    });
  });

  it("allows errors to override the shared duration", () => {
    expect(createToastArgs("error", {
      content: "Failed to load MCP server list",
      duration: 4,
      key: "mcp-server-catalog-load-failed",
    })).toMatchObject({
      key: "mcp-server-catalog-load-failed",
      duration: 4,
      pauseOnHover: true,
      showProgress: true,
      role: "alert",
    });
  });

  it("auto-dismisses non-error feedback using the shared durations", () => {
    expect(createToastArgs("success", "已保存")).toMatchObject({
      message: "已保存",
      placement: "bottomRight",
      duration: 3,
      pauseOnHover: true,
      showProgress: true,
      role: "status",
    });

    expect(createToastArgs("warning", "请检查设置")).toMatchObject({
      duration: 8,
      role: "status",
    });
  });

  it("preserves a stable key for repeated notifications", () => {
    expect(createToastArgs("info", {
      key: "voice-shortcut-register-failed",
      content: "快捷键注册失败",
    })).toMatchObject({
      key: "voice-shortcut-register-failed",
      duration: 5,
    });
  });
  it("preserves text at or below the global limit", () => {
    const content = "a".repeat(TOAST_TEXT_LIMIT);
    expect(guardToastText(content)).toBe(content);
  });

  it("removes ANSI terminal sequences from toast text", () => {
    expect(guardToastText("\u001b[31mfatal:\u001b[0m failed")).toBe("fatal: failed");
    expect(createToastArgs("error", "\u001b[31mfailed\u001b[0m").message).toBe("failed");
  });

  it("wraps text over the global limit with the complete content", () => {
    const content = "Receiving objects: 8% ".repeat(40);
    const guarded = guardToastText(content);

    expect(truncateToastText(content)).toHaveLength(TOAST_TEXT_LIMIT);
    expect(truncateToastText(content)).toMatch(/…$/);
    expect(guarded).toMatchObject({
      props: { text: content },
    });
    expect(createToastArgs("error", content).message).toMatchObject({
      props: { text: content },
    });
  });

  it("does not alter custom React content", () => {
    const content = createElement("strong", null, "自定义内容");
    expect(guardToastText(content)).toBe(content);
  });
});
