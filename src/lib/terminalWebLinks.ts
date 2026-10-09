import type { ILinkHandler } from "@xterm/xterm";

// 保留 URL 内的成对括号及 IPv6 方括号，排除外层括号和句末标点。
// 不带 g：WebLinksAddon 会自行添加全局标志。
export const TERMINAL_WEB_URL_PATTERN = /https?:\/\/(?:[^\s"'`<>\\|{}()\[\]，。；：！？、]|\([^\s"'`<>\\|{}()，。；：！？、]*\)|\[[0-9a-f:.]+\])+(?<![.,!?:;])/i;

export function createTerminalWebLinkHandler(
  onActivate: (uri: string) => void,
  onHover: (uri: string, event: MouseEvent) => void,
  onLeave: () => void,
) {
  return {
    allowNonHttpProtocols: false,
    activate: (event, uri) => {
      if (event.button !== 0) return;
      // 普通文本链接与 OSC 8 链接共用协议校验及确认流程。
      try {
        const { protocol } = new URL(uri);
        if (protocol !== "http:" && protocol !== "https:") return;
      } catch {
        return;
      }
      onActivate(uri);
    },
    hover: (event, uri) => onHover(uri, event),
    leave: onLeave,
  } satisfies ILinkHandler;
}
