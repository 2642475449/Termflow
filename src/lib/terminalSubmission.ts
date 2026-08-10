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

/**
 * Ctrl+C is delivered to a terminal PTY as ETX (SIGINT).  Agent CLIs do not
 * consistently emit a lifecycle hook when that interrupts an in-flight turn,
 * so callers can use this as a local, conservative status fallback.
 */
export function containsTerminalInterrupt(data: string): boolean {
  return data.includes("\x03");
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
