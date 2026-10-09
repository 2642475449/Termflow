export interface TerminalWheelContext {
  agentId: string | undefined;
  bufferType: "normal" | "alternate";
  mouseTrackingMode: "none" | "x10" | "vt200" | "drag" | "any";
  cols: number;
  rows: number;
  screen: { left: number; top: number; width: number; height: number };
}

type TerminalWheelEvent = Pick<WheelEvent,
  "deltaY" | "deltaMode" | "clientX" | "clientY" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey" |
  "preventDefault" | "stopPropagation"
>;

/** PI 全屏模式缺少鼠标上报时，不能让 xterm 把滚轮降级成提示词历史的方向键。 */
export function createTerminalWheelHandler(
  getContext: () => TerminalWheelContext | null,
  sendInput: (data: string) => void,
): (event: TerminalWheelEvent) => boolean {
  let pendingLines = 0;
  return (event) => {
    const context = getContext();
    if (!context || context.agentId !== "pi" || context.bufferType !== "alternate" ||
      (context.mouseTrackingMode !== "none" && context.mouseTrackingMode !== "x10") ||
      event.ctrlKey || event.metaKey || event.deltaY === 0) {
      pendingLines = 0;
      return true;
    }
    event.preventDefault();
    event.stopPropagation();
    const { screen, rows, cols } = context;
    if (rows <= 0 || cols <= 0 || screen.height <= 0 || screen.width <= 0) return false;
    const cellHeight = screen.height / rows;
    // DOM_DELTA_PIXEL / LINE / PAGE；小幅触控板事件累计到一行再发送。
    const lines = event.deltaMode === 1 ? event.deltaY
      : event.deltaMode === 2 ? event.deltaY * rows : event.deltaY / cellHeight;
    if (pendingLines * lines < 0) pendingLines = 0;
    pendingLines += lines;
    if (Math.abs(pendingLines) < 1) return false;
    const direction = pendingLines < 0 ? 64 : 65;
    pendingLines %= 1;
    const column = Math.max(1, Math.min(cols, Math.floor((event.clientX - screen.left) / (screen.width / cols)) + 1));
    const row = Math.max(1, Math.min(rows, Math.floor((event.clientY - screen.top) / cellHeight) + 1));
    const modifiers = (event.shiftKey ? 4 : 0) + (event.altKey ? 8 : 0);
    // PI 的全屏视口原生识别 SGR wheel；每个滚轮事件发一次，由 PI 控制滚动速度。
    sendInput(`\x1b[<${direction + modifiers};${column};${row}M`);
    return false;
  };
}
