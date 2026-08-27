/**
 * Keeps terminal output from moving xterm's cursor while an IME owns the
 * textarea. xterm submits the committed text on a zero-delay task after
 * `compositionend`, so output must remain paused for that task as well.
 */
export function createTerminalImeOutputGate(
  write: (data: string) => void,
  schedule: (callback: () => void) => number = (callback) => window.setTimeout(callback, 0),
  cancel: (handle: number) => void = (handle) => window.clearTimeout(handle),
) {
  let isComposing = false;
  let isSettlingComposition = false;
  let pendingOutput = "";
  let flushHandle: number | null = null;

  const flush = () => {
    flushHandle = null;
    if (isComposing) return;
    isSettlingComposition = false;
    if (!pendingOutput) return;
    const output = pendingOutput;
    pendingOutput = "";
    write(output);
  };

  return {
    compositionStart() {
      isComposing = true;
    },
    compositionEnd() {
      isComposing = false;
      isSettlingComposition = true;
      if (flushHandle === null) {
        // Registered after xterm's listener, this runs after xterm has sent
        // the finalized IME text to the PTY.
        flushHandle = schedule(flush);
      }
    },
    write(data: string) {
      if (isComposing || isSettlingComposition) {
        pendingOutput += data;
        return;
      }
      write(data);
    },
    dispose() {
      if (flushHandle !== null) {
        cancel(flushHandle);
        flushHandle = null;
      }
      pendingOutput = "";
    },
  };
}
