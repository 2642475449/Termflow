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
 * CLI 中断不一定发出生命周期 Hook，因此使用按键作为本地状态兜底。
 * Antigravity 用独立 Esc 中断；方向键等含 Esc 的序列不能误判为中断。
 */
export function containsTerminalInterrupt(data: string, agentId?: unknown): boolean {
  return data.includes("\x03") || (agentId === "antigravity" && data === "\x1b");
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
