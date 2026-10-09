import { describe, expect, it, vi } from "vitest";
import { createTerminalWebLinkHandler, TERMINAL_WEB_URL_PATTERN } from "./terminalWebLinks";

const leftClick = { button: 0 } as MouseEvent;

describe("terminal web links", () => {
  it("recognizes the complete URLs from complex terminal output", () => {
    const urls = [
      "https://www.google.com/search?q=hello%20world&hl=zh-CN",
      "https://www.google.com/search?q=中文测试&hl=zh-CN#result",
      "https://example.com/中文目录/测试文件.html?关键词=你好&页码=2",
      "https://en.wikipedia.org/wiki/Function_(mathematics)",
      "http://[::1]:3000/test?mode=preview",
      "http://127.0.0.1:8080/api/test?q=a%26b%3Dc#debug",
    ];
    for (const url of urls) {
      expect(`(${url})`.match(TERMINAL_WEB_URL_PATTERN)?.[0]).toBe(url);
    }
  });

  it("excludes surrounding prose and punctuation while retaining multiple URLs", () => {
    const text = "前面有中文https://www.google.com/search?q=test。 两个地址：https://www.google.com 和 https://example.com.";
    const pattern = new RegExp(TERMINAL_WEB_URL_PATTERN.source, "gi");
    expect(Array.from(text.matchAll(pattern), (match) => match[0])).toEqual([
      "https://www.google.com/search?q=test",
      "https://www.google.com",
      "https://example.com",
    ]);
  });

  it("routes OSC 8 URLs to the application confirmation flow", () => {
    const activate = vi.fn();
    const handler = createTerminalWebLinkHandler(activate, vi.fn(), vi.fn());
    const uri = "https://github.com/openai/codex/releases/latest";
    handler.activate(leftClick, uri);
    expect(activate).toHaveBeenCalledExactlyOnceWith(uri);
    expect(handler.allowNonHttpProtocols).toBe(false);
  });

  it("ignores non-left clicks, malformed URLs and non-web protocols", () => {
    const activate = vi.fn();
    const handler = createTerminalWebLinkHandler(activate, vi.fn(), vi.fn());
    handler.activate({ button: 2 } as MouseEvent, "https://example.com");
    for (const uri of ["invalid", "javascript:alert(1)", "file:///C:/test.txt", "ftp://example.com"]) {
      handler.activate(leftClick, uri);
    }
    expect(activate).not.toHaveBeenCalled();
  });

  it("preserves image hover previews and dismissal", () => {
    const hover = vi.fn();
    const leave = vi.fn();
    const handler = createTerminalWebLinkHandler(vi.fn(), hover, leave);
    const uri = "https://example.com/image.png";
    handler.hover(leftClick, uri);
    handler.leave();
    expect(hover).toHaveBeenCalledExactlyOnceWith(uri, leftClick);
    expect(leave).toHaveBeenCalledOnce();
  });
});
