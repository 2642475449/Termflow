const ESC = "\x1b";
const SYNC_END = `${ESC}[?2026l`;
const CURSOR_SHOW = `${ESC}[?25h`;
const FRAME_TIMEOUT_MS = 250;
const INPUT_FRAME_TIMEOUT_MS = 32;
const CURSOR_SETTLE_MS = 16;
const INPUT_WINDOW_MS = 150;
const MAX_FRAME_CHARS = 256 * 1024;

type OutputToken = { data: string; csi: boolean; safeAfter?: boolean };
type Timer = ReturnType<typeof setTimeout>;

interface TerminalOutputFrameOptions {
  enabled: boolean;
  now?: () => number;
}

interface FrameOutputTerminal {
  rows: number;
  buffer: {
    active: { type: string; cursorY: number; baseY: number; viewportY: number };
  };
  write(data: string, callback?: () => void): void;
  refresh(start: number, end: number): void;
}

/** 解析完成后补刷光标所在行；公开 refresh 会与 WebGL 已排队的绘制合并。 */
export function writeTerminalOutputWithCursorRefresh(
  terminal: FrameOutputTerminal,
  data: string,
  shouldRefresh: (() => boolean) | undefined,
  onParsed?: () => void,
): void {
  if (!shouldRefresh) {
    terminal.write(data, onParsed);
    return;
  }
  const before = terminal.buffer.active;
  const type = before.type;
  const baseY = before.baseY;
  const viewportY = before.viewportY;
  const cursorRow = baseY + before.cursorY - viewportY;
  terminal.write(data, () => {
    // 回调运行在 xterm 的解析循环内，异常不能中断后续输出。
    try {
      if (!shouldRefresh() || terminal.rows < 1) return;
      const after = terminal.buffer.active;
      if (after.type !== type || after.baseY !== baseY || after.viewportY !== viewportY) {
        terminal.refresh(0, terminal.rows - 1);
        return;
      }
      const afterRow = after.baseY + after.cursorY - after.viewportY;
      const start = Math.max(0, Math.min(cursorRow, afterRow));
      const end = Math.min(terminal.rows - 1, Math.max(cursorRow, afterRow));
      if (start <= end) terminal.refresh(start, end);
    } catch {
      // 终端卸载或渲染器切换可与解析回调交错。
    } finally {
      onParsed?.();
    }
  });
}

// 字符串控制序列中的内容不能误认成帧标记；CSI 自身也可能跨 PTY 数据块。
function createOutputScanner() {
  let mode: "text" | "escape" | "csi" | "string" = "text";
  let pending = "";
  let stringIsOsc = false;
  let stringEscape = false;
  let streamedCsi = false;

  return {
    scan(data: string): OutputToken[] {
      const tokens: OutputToken[] = [];
      let text = "";
      const flushText = () => {
        if (text) tokens.push({ data: text, csi: false, safeAfter: mode !== "string" && !streamedCsi });
        text = "";
      };
      for (const char of data) {
        if (mode === "string") {
          text += char;
          if (
            char === "\x9c" ||
            (stringIsOsc && char === "\x07") ||
            (stringEscape && char === "\\")
          ) {
            mode = "text";
          }
          stringEscape = char === ESC;
          continue;
        }
        if (mode === "text") {
          if (char === ESC || char === "\x9b") {
            flushText();
            pending = char;
            mode = char === ESC ? "escape" : "csi";
          } else if ("\x90\x98\x9d\x9e\x9f".includes(char)) {
            text += char;
            stringIsOsc = char === "\x9d";
            stringEscape = false;
            mode = "string";
          } else {
            text += char;
          }
          continue;
        }
        if (char === ESC || char === "\x18" || char === "\x1a") {
          tokens.push({ data: pending, csi: false, safeAfter: false });
          pending = char === ESC ? char : "";
          if (char !== ESC) tokens.push({ data: char, csi: false });
          mode = char === ESC ? "escape" : "text";
          streamedCsi = false;
          continue;
        }
        pending += char;
        if (mode === "escape") {
          if (pending === `${ESC}[`) {
            mode = "csi";
          } else if (pending.length === 2 && "]P^_X".includes(char)) {
            tokens.push({ data: pending, csi: false, safeAfter: false });
            pending = "";
            stringIsOsc = char === "]";
            stringEscape = false;
            mode = "string";
          } else if (char >= "0" && char <= "~") {
            tokens.push({ data: pending, csi: false });
            pending = "";
            mode = "text";
          }
        } else if (char >= "@" && char <= "~") {
          tokens.push({ data: pending, csi: !streamedCsi });
          pending = "";
          mode = "text";
          streamedCsi = false;
        }
        if (pending.length >= MAX_FRAME_CHARS) {
          tokens.push({ data: pending, csi: false, safeAfter: false });
          pending = "";
          streamedCsi = true;
        }
      }
      flushText();
      return tokens;
    },
    canInsertControl: () => mode === "text" && !streamedCsi,
    hasPendingSequence: () => pending.length > 0,
    getBufferedChars: () => pending.length,
    finish() {
      const tail = pending;
      const incomplete = mode !== "text" || streamedCsi;
      pending = "";
      mode = "text";
      streamedCsi = false;
      return { tail, incomplete };
    },
  };
}

function getPrivateMode(token: OutputToken, mode: number): "h" | "l" | null {
  if (!token.csi) return null;
  const match = /^(?:\x1b\[|\x9b)\?([\d;]+)([hl])$/.exec(token.data);
  if (!match || !match[1].split(";").includes(String(mode))) return null;
  return match[2] === "h" ? "h" : "l";
}

function isCursorPlacement(token: OutputToken): boolean {
  return token.csi && /^(?:\x1b\[|\x9b)[\d;]*[GHf]$/.test(token.data);
}

function needsCursorSettlement(tokens: OutputToken[]): boolean {
  let hidden = false;
  let shownAfterHide = false;
  let placedAfterShow = false;
  let frameEnded = false;
  let restoredAfterEnd = false;
  let hiddenAfterEnd = false;
  let placedAfterEnd = false;
  for (const token of tokens) {
    if (getPrivateMode(token, 2026) === "l") frameEnded = true;
    const visibility = getPrivateMode(token, 25);
    if (visibility === "l") {
      hidden = true;
      shownAfterHide = false;
      hiddenAfterEnd = frameEnded;
      placedAfterEnd = false;
    } else if (visibility === "h") {
      shownAfterHide = hidden;
      placedAfterShow = false;
      restoredAfterEnd = hiddenAfterEnd && placedAfterEnd;
    } else if (shownAfterHide && isCursorPlacement(token)) {
      placedAfterShow = true;
    }
    if (hiddenAfterEnd && isCursorPlacement(token)) placedAfterEnd = true;
  }
  return shownAfterHide && !placedAfterShow && !restoredAfterEnd;
}

// 先完成帧内容和最终定位，再显示光标；帧内短暂 show→hide 不应被绘制。
function stabilizeFrameCursor(tokens: OutputToken[]): string {
  let showPending = false;
  const output: string[] = [];
  for (const token of tokens) {
    if (token.csi && (token.data === CURSOR_SHOW || token.data === "\x9b?25h")) {
      showPending = true;
    } else {
      if (getPrivateMode(token, 25) === "l") showPending = false;
      output.push(token.data);
    }
  }
  if (showPending) output.push(CURSOR_SHOW);
  return output.join("");
}

/** Windows ConPTY 输出在交给 xterm 前按 DEC 2026 帧收敛，缓冲不阻塞普通回显。 */
export function createTerminalOutputFrameGate(
  write: (data: string, synchronizedFrame: boolean) => void,
  options: TerminalOutputFrameOptions,
) {
  const scanner = createOutputScanner();
  const now = options.now ?? Date.now;
  let tokens: OutputToken[] = [];
  let queuedChars = 0;
  let frameActive = false;
  let frameBuffered = false;
  let frameStartedAt = 0;
  let lastInputAt = -Infinity;
  let timer: Timer | null = null;
  let timerDeadline = Infinity;
  let disposed = false;
  let releaseSyncWhenSafe = false;
  let restoreCursor = false;
  let cursorRestoreTimer: Timer | null = null;
  let cursorRestoreDeadline = Infinity;
  let nativeCursorShown = false;

  const cancelTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    timerDeadline = Infinity;
  };

  const emit = (
    data: string,
    synchronizedFrame = false,
    safeBoundary = scanner.canInsertControl(),
  ) => {
    if (!data && !restoreCursor && !releaseSyncWhenSafe) return;
    let cursorRestored = false;
    if (safeBoundary) {
      if (releaseSyncWhenSafe) {
        data += SYNC_END;
        releaseSyncWhenSafe = false;
      }
      if (restoreCursor && cursorRestoreTimer === null) {
        data += CURSOR_SHOW;
        restoreCursor = false;
        cursorRestored = true;
      }
    }
    if (data) write(data, synchronizedFrame || cursorRestored);
  };

  const drain = (force = false) => {
    cancelTimer();
    const synchronizedFrame = frameBuffered;
    const safeBoundary =
      tokens.length > 0
        ? tokens[tokens.length - 1].safeAfter !== false
        : scanner.canInsertControl();
    const data =
      frameBuffered && safeBoundary
        ? stabilizeFrameCursor(tokens)
        : tokens.map((token) => token.data).join("");
    tokens = [];
    queuedChars = 0;
    if (force && frameActive) releaseSyncWhenSafe = true;
    frameActive = false;
    frameBuffered = false;
    emit(data, synchronizedFrame, safeBoundary);
  };

  const scheduleDeadline = (deadline: number) => {
    if (timerDeadline <= deadline) return;
    cancelTimer();
    timerDeadline = deadline;
    timer = setTimeout(() => {
      if (!disposed) drain(true);
    }, Math.max(0, deadline - now()));
  };

  const scheduleCursorRestore = () => {
    if (cursorRestoreTimer !== null) clearTimeout(cursorRestoreTimer);
    cursorRestoreTimer = setTimeout(() => {
      cursorRestoreTimer = null;
      if (!frameBuffered && !scanner.hasPendingSequence()) emit("");
    }, Math.max(0, Math.min(INPUT_FRAME_TIMEOUT_MS, cursorRestoreDeadline - now())));
  };

  return {
    write(data: string) {
      if (disposed || !data) return;
      if (restoreCursor && cursorRestoreTimer !== null) scheduleCursorRestore();
      const scanned = scanner.scan(data);
      if (scanned.some((token) => getPrivateMode(token, 25) === "h")) nativeCursorShown = true;
      if (!options.enabled) {
        // 非 Windows 同样跟踪解析边界，恢复光标不能插进未完成的 OSC/CSI。
        emit(data);
        return;
      }
      for (const token of scanned) {
        const synchronized = getPrivateMode(token, 2026);
        if (synchronized === "h" && !frameActive) {
          drain();
          frameActive = true;
          frameBuffered = true;
          frameStartedAt = now();
        }
        tokens.push(token);
        queuedChars += token.data.length;
        if (synchronized === "l") frameActive = false;
        if (queuedChars >= MAX_FRAME_CHARS) drain(true);
      }
      if (frameActive) {
        const timeout =
          now() - lastInputAt <= INPUT_WINDOW_MS ? INPUT_FRAME_TIMEOUT_MS : FRAME_TIMEOUT_MS;
        scheduleDeadline(frameStartedAt + timeout);
      } else if (frameBuffered && (scanner.hasPendingSequence() || needsCursorSettlement(tokens))) {
        scheduleDeadline(now() + CURSOR_SETTLE_MS);
      } else {
        drain();
      }
    },
    getBufferedChars: () => queuedChars + scanner.getBufferedChars(),
    hasNativeCursor: () => nativeCursorShown,
    markUserInput() {
      if (disposed) return;
      lastInputAt = now();
      if (frameActive) scheduleDeadline(now() + INPUT_FRAME_TIMEOUT_MS);
    },
    requestCursorRestore() {
      if (disposed) return;
      if (!restoreCursor) cursorRestoreDeadline = now() + FRAME_TIMEOUT_MS;
      restoreCursor = true;
      // 等本次状态切换后的重绘到齐，避免先 show 又被末尾的 hide 覆盖。
      scheduleCursorRestore();
    },
    cancelCursorRestore() {
      restoreCursor = false;
      if (cursorRestoreTimer !== null) clearTimeout(cursorRestoreTimer);
      cursorRestoreTimer = null;
    },
    flush() {
      if (disposed) return;
      if (options.enabled) {
        const { tail, incomplete } = scanner.finish();
        if (tail || incomplete) {
          tokens.push({ data: `${tail}${incomplete ? "\x18" : ""}`, csi: false });
        }
        drain(true);
      }
    },
    dispose() {
      disposed = true;
      cancelTimer();
      if (cursorRestoreTimer !== null) clearTimeout(cursorRestoreTimer);
      tokens = [];
      queuedChars = 0;
      scanner.finish();
    },
  };
}
