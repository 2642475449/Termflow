import { describe, expect, it, vi } from "vitest";
import { createTerminalWebLinkHandler, parseTerminalFileUrl, TERMINAL_WEB_URL_PATTERN } from "./terminalWebLinks";

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

  it("decodes local file URLs across Windows, POSIX and UNC paths", () => {
    const cases = [
      ["file:///C:/audio/my%20song.mp3", "C:/audio/my song.mp3"],
      ["file://localhost/C:/audio/song.mp3", "C:/audio/song.mp3"],
      ["FILE:///D:/%E8%B5%84%E6%96%99/%E6%8A%A5%E5%91%8A.pdf", "D:/资料/报告.pdf"],
      ["file:///home/user/audio/my%20song.mp3", "/home/user/audio/my song.mp3"],
      ["file://server/share/folder%20name/report.pdf", "//server/share/folder name/report.pdf"],
      ["file:///C:/report%23final%3F.txt", "C:/report#final?.txt"],
      ["file:///C:/literal%2520.txt", "C:/literal%20.txt"],
      ["file:///", "/"],
    ];
    for (const [uri, path] of cases) expect(parseTerminalFileUrl(uri)).toBe(path);
  });

  it("rejects ambiguous or malformed file URLs without modifying their path", () => {
    const invalid = [
      "C:/audio/song.mp3", "https://example.com/song.mp3", "file:relative.txt",
      "file:///C:/bad%ZZ.txt", "file:///C:/bad%C0%AF.txt", "file:///C:/bad%00.txt",
      "file:///C:/bad%0a.txt", "file:///C:/bad%7f.txt", "file:///C:/bad\tname.txt",
      "file://user:password@server/share/report.pdf", "file://server:123/share/report.pdf",
      "file:///C:/report.pdf?download=1", "file:///C:/report.pdf#page=2",
      "file:///C:/report.pdf?", "file:///C:/report.pdf#", " file:///C:/report.pdf",
    ];
    for (const uri of invalid) expect(parseTerminalFileUrl(uri)).toBeNull();
  });

  it("routes OSC 8 file links and hover previews through the local file flow", () => {
    const webActivate = vi.fn();
    const webHover = vi.fn();
    const fileActivate = vi.fn();
    const fileHover = vi.fn();
    const leave = vi.fn();
    const handler = createTerminalWebLinkHandler(webActivate, webHover, leave, {
      activate: fileActivate,
      hover: fileHover,
    });
    const event = { button: 0, ctrlKey: true, metaKey: false } as MouseEvent;
    const uri = "file:///C:/my%20folder/song.mp3";
    handler.activate(event, uri);
    handler.hover(event, uri);
    handler.leave();
    expect(handler.allowNonHttpProtocols).toBe(true);
    expect(fileActivate).toHaveBeenCalledExactlyOnceWith("C:/my folder/song.mp3", event);
    expect(fileHover).toHaveBeenCalledExactlyOnceWith("C:/my folder/song.mp3", event);
    expect(webActivate).not.toHaveBeenCalled();
    expect(webHover).not.toHaveBeenCalled();
    expect(leave).toHaveBeenCalledOnce();
  });

  it("keeps web links working when local file handling is enabled", () => {
    const webActivate = vi.fn();
    const webHover = vi.fn();
    const fileActivate = vi.fn();
    const handler = createTerminalWebLinkHandler(webActivate, webHover, vi.fn(), { activate: fileActivate });
    const uri = "https://example.com/report.pdf";
    handler.activate(leftClick, uri);
    handler.hover(leftClick, uri);
    expect(webActivate).toHaveBeenCalledExactlyOnceWith(uri);
    expect(webHover).toHaveBeenCalledExactlyOnceWith(uri, leftClick);
    expect(fileActivate).not.toHaveBeenCalled();
  });

  it("does not enable arbitrary protocols when local file handling is enabled", () => {
    const webActivate = vi.fn();
    const webHover = vi.fn();
    const fileActivate = vi.fn();
    const fileHover = vi.fn();
    const handler = createTerminalWebLinkHandler(webActivate, webHover, vi.fn(), {
      activate: fileActivate,
      hover: fileHover,
    });
    for (const uri of ["invalid", "javascript:alert(1)", "ftp://example.com/a", "vscode://file/C:/test.txt", "file:///C:/bad%ZZ.txt"]) {
      handler.activate(leftClick, uri);
      handler.hover(leftClick, uri);
    }
    handler.activate({ button: 2 } as MouseEvent, "file:///C:/song.mp3");
    expect(webActivate).not.toHaveBeenCalled();
    expect(webHover).not.toHaveBeenCalled();
    expect(fileActivate).not.toHaveBeenCalled();
    expect(fileHover).not.toHaveBeenCalled();
  });

  it("leaves Alt mouse interactions to the CLI for both web and file links", () => {
    const webActivate = vi.fn();
    const fileActivate = vi.fn();
    const handler = createTerminalWebLinkHandler(webActivate, vi.fn(), vi.fn(), { activate: fileActivate });
    const event = { button: 0, altKey: true } as MouseEvent;
    handler.activate(event, "https://example.com/report.pdf");
    handler.activate(event, "file:///C:/audio/song.mp3");
    expect(webActivate).not.toHaveBeenCalled();
    expect(fileActivate).not.toHaveBeenCalled();
  });
});
