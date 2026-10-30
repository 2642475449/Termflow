import type { ILinkHandler } from "@xterm/xterm";

// 保留 URL 内的成对括号及 IPv6 方括号，排除外层括号和句末标点。
// 不带 g：WebLinksAddon 会自行添加全局标志。
export const TERMINAL_WEB_URL_PATTERN = /https?:\/\/(?:[^\s"'`<>\\|{}()\[\]，。；：！？、]|\([^\s"'`<>\\|{}()，。；：！？、]*\)|\[[0-9a-f:.]+\])+(?<![.,!?:;])/i;

export interface TerminalFileLinkHandlers {
  activate: (path: string, event: MouseEvent) => unknown;
  hover?: (path: string, event: MouseEvent) => unknown;
}

/** file URL 与网页 URL 分流，保留解码后的 Windows、UNC 或 POSIX 路径。 */
export function parseTerminalFileUrl(uri: string): string | null {
  if (!/^file:\/\//i.test(uri) || /[\u0000-\u001f\u007f]/.test(uri) || uri !== uri.trim()) return null;
  try {
    const url = new URL(uri);
    // 查询和片段不属于文件路径；文件名内的 ?/# 必须使用百分号编码。
    if (url.protocol !== "file:" || url.username || url.password || url.port || uri.includes("?") || uri.includes("#")) return null;
    const pathname = decodeURIComponent(url.pathname);
    if (/[\u0000-\u001f\u007f]/.test(pathname)) return null;
    if (url.hostname) return `//${url.hostname}${pathname}`;
    return /^\/[a-zA-Z]:\//.test(pathname) ? pathname.slice(1) : pathname;
  } catch {
    return null;
  }
}

export function createTerminalWebLinkHandler(
  onActivate: (uri: string) => void,
  onHover: (uri: string, event: MouseEvent) => void,
  onLeave: () => void,
  fileLinks?: TerminalFileLinkHandlers,
) {
  const classify = (uri: string): { kind: "web" } | { kind: "file"; path: string } | null => {
    try {
      const { protocol } = new URL(uri);
      if (protocol === "http:" || protocol === "https:") return { kind: "web" };
      const path = fileLinks && protocol === "file:" ? parseTerminalFileUrl(uri) : null;
      return path === null ? null : { kind: "file", path };
    } catch {
      return null;
    }
  };
  return {
    // xterm 默认在调用 handler 前过滤 file:，只有接好本地打开流程才放行。
    allowNonHttpProtocols: Boolean(fileLinks),
    activate: (event, uri) => {
      // Alt 鼠标手势用于 CLI 的鼠标协议，不应同时触发链接打开。
      if (event.button !== 0 || event.altKey) return;
      const target = classify(uri);
      if (target?.kind === "web") onActivate(uri);
      else if (target?.kind === "file") fileLinks?.activate(target.path, event);
    },
    hover: (event, uri) => {
      const target = classify(uri);
      if (target?.kind === "web") onHover(uri, event);
      else if (target?.kind === "file") fileLinks?.hover?.(target.path, event);
    },
    leave: onLeave,
  } satisfies ILinkHandler;
}
