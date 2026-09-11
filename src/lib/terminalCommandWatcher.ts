export interface TerminalCommandCompletion {
  commandId: number;
  durationMs: number;
  exitCode: number | null;
}

export type TerminalCommandWatcherStatus = "unavailable" | "idle" | "running";

export interface TerminalCommandWatcher {
  consumeOsc133: (data: string, nowMs: number) => TerminalCommandCompletion | null;
  reset: () => void;
  getStatus: () => TerminalCommandWatcherStatus;
}

interface RunningCommand {
  commandId: number;
  startedAtMs: number;
}

function parseExitCode(value: string | undefined): number | null {
  if (value === undefined || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Tracks the explicit OSC 133 C → D lifecycle emitted by a shell integration.
 * It intentionally does not infer completion from prompt text, elapsed silence,
 * or user input, because none of those observations proves a command ended.
 */
export function createTerminalCommandWatcher(): TerminalCommandWatcher {
  let sawIntegrationSignal = false;
  let nextCommandId = 1;
  let running: RunningCommand | null = null;

  return {
    consumeOsc133: (data, nowMs) => {
      const [marker, exitCodeValue] = data.split(";", 2);
      if (marker !== "A" && marker !== "B" && marker !== "C" && marker !== "D") {
        return null;
      }

      sawIntegrationSignal = true;
      if (marker === "C") {
        running = { commandId: nextCommandId, startedAtMs: nowMs };
        nextCommandId += 1;
        return null;
      }

      if (marker !== "D" || running === null) return null;

      const completion = {
        commandId: running.commandId,
        durationMs: Math.max(0, nowMs - running.startedAtMs),
        exitCode: parseExitCode(exitCodeValue),
      };
      running = null;
      return completion;
    },
    reset: () => {
      running = null;
    },
    getStatus: () => {
      if (running) return "running";
      return sawIntegrationSignal ? "idle" : "unavailable";
    },
  };
}
