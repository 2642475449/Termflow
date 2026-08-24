export interface TerminalGridSize {
  rows: number;
  cols: number;
}

/**
 * Prevents repeated SIGWINCH notifications when a layout refresh does not
 * actually change the terminal grid. Full-screen TUIs may redraw their entire
 * normal-screen buffer after every resize, polluting xterm scrollback.
 */
export function createPtyResizeGate(
  resize: (rows: number, cols: number) => void,
): (rows: number, cols: number) => boolean {
  let lastSize: TerminalGridSize | null = null;

  return (rows, cols) => {
    if (lastSize?.rows === rows && lastSize.cols === cols) {
      return false;
    }

    lastSize = { rows, cols };
    resize(rows, cols);
    return true;
  };
}
