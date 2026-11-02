const CSI_FINAL_BYTE = /[@-~]/;
const SS3_FINAL_BYTE = /[\x30-\x7e]/;

export interface TerminalSubmissionCapture {
  nextValue: string;
  pendingSequence: string;
  submittedText: string | null;
}

/**
 * Tracks user-authored text separately from terminal navigation sequences.
 * A bare Enter in a TUI menu therefore stays distinct from submitting a prompt.
 */
export function consumeTerminalSubmissionInput(
  currentValue: string,
  data: string,
  pendingSequence = "",
): TerminalSubmissionCapture {
  // xterm 单独发送的 Esc 是一次完整按键，不能吞掉下次输入的首字符。
  if (data === "\x1b" && !pendingSequence) {
    return { nextValue: currentValue, pendingSequence: "", submittedText: null };
  }
  const source = `${pendingSequence}${data}`;
  let nextValue = currentValue;
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (char === "\r" || char === "\n") {
      return {
        nextValue: "",
        pendingSequence: "",
        submittedText: nextValue,
      };
    }

    if (char === "\u007f" || char === "\b") {
      nextValue = nextValue.slice(0, -1);
      index += 1;
      continue;
    }

    if (char === "\x15" || char === "\x03") {
      nextValue = "";
      index += 1;
      continue;
    }

    if (char === "\x17") {
      nextValue = nextValue.replace(/\S+\s*$/, "");
      index += 1;
      continue;
    }

    if (char === "\x1b") {
      const nextIndex = consumeTerminalEscapeSequence(source, index);
      if (nextIndex === null) {
        return {
          nextValue,
          pendingSequence: source.slice(index),
          submittedText: null,
        };
      }
      index = nextIndex;
      continue;
    }

    if (char >= " ") {
      nextValue += char;
    }
    index += 1;
  }

  return {
    nextValue,
    pendingSequence: "",
    submittedText: null,
  };
}

export function hasTerminalPromptText(input: string | null): boolean {
  return Boolean(input?.trim());
}

/** A pasted-image preview is valid only while its exact inserted path remains. */
export function terminalInputContainsInsertedText(
  input: string,
  insertedText: string,
): boolean {
  return insertedText.length > 0 && input.includes(insertedText);
}

/**
 * 识别中断意图，不代表中断已经完成。粘贴、方向键和 Kitty 松键/重复事件不算中断。
 */
export function containsTerminalInterrupt(data: string, agentId?: unknown): boolean {
  const escape = data === "\x1b" || /^\x1b\[27(?:;1(?::1)?)?u$/.test(data);
  const ctrlC = data === "\x03" || /^\x1b\[99;5(?::1)?u$/.test(data);
  // Codex 的 Ctrl+C 还可退出侧边对话，不能据此推断主任务被中断。
  return ctrlC ? agentId !== "codex" : escape
    && ["claude", "codex", "antigravity", "opencode", "qoder", "pi"].includes(String(agentId));
}

function consumeTerminalEscapeSequence(source: string, start: number): number | null {
  const command = source[start + 1];
  if (command === undefined) return null;

  if (command === "[") {
    for (let index = start + 2; index < source.length; index += 1) {
      if (CSI_FINAL_BYTE.test(source[index])) return index + 1;
    }
    return null;
  }

  if (command === "O") {
    const finalByte = source[start + 2];
    if (finalByte === undefined) return null;
    return SS3_FINAL_BYTE.test(finalByte) ? start + 3 : start + 2;
  }

  if (command === "]") {
    for (let index = start + 2; index < source.length; index += 1) {
      if (source[index] === "\u0007") return index + 1;
      if (source[index] === "\x1b") {
        const nextChar = source[index + 1];
        if (nextChar === "\\") return index + 2;
        if (nextChar === undefined) return null;
      }
    }
    return null;
  }

  if (command === "P" || command === "X" || command === "^" || command === "_") {
    for (let index = start + 2; index < source.length; index += 1) {
      if (source[index] !== "\x1b") continue;
      const nextChar = source[index + 1];
      if (nextChar === "\\") return index + 2;
      if (nextChar === undefined) return null;
    }
    return null;
  }

  return start + 2;
}
