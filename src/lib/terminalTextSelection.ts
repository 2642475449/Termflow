import type { IBufferCell, IBufferRange, Terminal } from "@xterm/xterm";

interface TerminalSelectionLine {
  getCell: (column: number) => Pick<IBufferCell, "getChars" | "getWidth"> | undefined;
}

export interface TerminalTextSelectionRow {
  row: number;
  startColumn: number;
  endColumn: number;
}

/** xterm 的选择坐标实际从 0 开始；按单元格宽度处理中文和 emoji。 */
export function getTerminalTextSelectionRows(
  range: IBufferRange,
  viewportY: number,
  rows: number,
  cols: number,
  getLine: (row: number) => TerminalSelectionLine | undefined,
): TerminalTextSelectionRow[] {
  const result: TerminalTextSelectionRow[] = [];
  for (let row = Math.max(viewportY, range.start.y); row <= Math.min(viewportY + rows - 1, range.end.y); row++) {
    const line = getLine(row);
    if (!line) continue;
    const from = row === range.start.y ? range.start.x : 0;
    const to = row === range.end.y ? range.end.x : cols;
    let startColumn = cols;
    let endColumn = 0;
    // 扫描完整行，确保选区起点落在宽字符的后半格时也能正确显示。
    for (let column = 0; column < Math.min(to, cols); column++) {
      const cell = line.getCell(column);
      if (!cell || !cell.getChars().trim()) continue;
      const end = Math.min(column + cell.getWidth(), to);
      if (end <= from) continue;
      startColumn = Math.min(startColumn, Math.max(column, from));
      endColumn = Math.max(endColumn, end);
    }
    if (endColumn > startColumn) result.push({ row: row - viewportY, startColumn, endColumn });
  }
  return result;
}

/** 保留 xterm 的选区、复制和鼠标协议，只替换普通拖选的空白高亮。 */
export function installTerminalTextSelection(term: Terminal): () => void {
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return () => {};
  const document = screen.ownerDocument;
  const window = document.defaultView;
  if (!window) return () => {};
  const originalTheme = { ...term.options.theme };
  const textTheme = {
    ...originalTheme,
    selectionBackground: "transparent",
    selectionInactiveBackground: "transparent",
    selectionForeground: undefined,
  };
  const overlay = document.createElement("div");
  overlay.className = "app-terminal-text-selection";
  overlay.setAttribute("aria-hidden", "true");
  screen.appendChild(overlay);
  let nativeSelection = false;
  let frame: number | null = null;
  let dragging = false;
  term.options.theme = textTheme;

  const render = () => {
    frame = null;
    overlay.replaceChildren();
    const range = term.getSelectionPosition();
    if (nativeSelection || !range) return;
    const buffer = term.buffer.active;
    const selectedRows = getTerminalTextSelectionRows(range, buffer.viewportY, term.rows, term.cols, (row) => buffer.getLine(row));
    const bounds = screen.getBoundingClientRect();
    const cellWidth = bounds.width / term.cols;
    const cellHeight = bounds.height / term.rows;
    const fragment = document.createDocumentFragment();
    for (const row of selectedRows) {
      const highlight = document.createElement("div");
      highlight.className = "app-terminal-text-selection-row";
      // 单元格几何来自当前终端尺寸，不能用固定 Tailwind 类表示。
      highlight.style.left = `${row.startColumn * cellWidth}px`;
      highlight.style.top = `${row.row * cellHeight}px`;
      highlight.style.width = `${(row.endColumn - row.startColumn) * cellWidth}px`;
      highlight.style.height = `${cellHeight}px`;
      fragment.appendChild(highlight);
    }
    overlay.appendChild(fragment);
  };
  const scheduleRender = () => {
    if (frame === null) frame = window.requestAnimationFrame(render);
  };
  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    dragging = true;
    // Alt 的矩形选择也交给 xterm 原生处理。
    const nextNativeSelection = event.shiftKey || event.altKey;
    if (nativeSelection !== nextNativeSelection) {
      nativeSelection = nextNativeSelection;
      overlay.replaceChildren();
      term.options.theme = nativeSelection ? originalTheme : textTheme;
    }
    scheduleRender();
  };
  const onMouseMove = () => { if (dragging) scheduleRender(); };
  const onMouseUp = () => { dragging = false; scheduleRender(); };
  screen.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  const disposables = [term.onSelectionChange(scheduleRender), term.onScroll(scheduleRender), term.onResize(scheduleRender), term.onRender(scheduleRender)];
  return () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    screen.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    disposables.forEach((disposable) => disposable.dispose());
    overlay.remove();
    term.options.theme = originalTheme;
  };
}
