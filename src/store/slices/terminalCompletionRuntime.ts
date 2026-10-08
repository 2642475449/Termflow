import type { TerminalCommandWatcherStatus } from "@/lib/terminalCommandWatcher";

export type TerminalCompletionIntegrationShell = "powershell" | "unsupported";
export type TerminalCompletionIntegrationStatus = "pending" | "available" | "unavailable";
export type TerminalCompletionIntegrationReason =
  | "unsupported-shell"
  | "integration-not-reported"
  | "command-lifecycle-unavailable"
  | "terminal-closed";

export interface TerminalCompletionIntegrationState {
  shell: TerminalCompletionIntegrationShell;
  status: TerminalCompletionIntegrationStatus;
  reason?: TerminalCompletionIntegrationReason;
  version?: string;
  updatedAt: number;
}

export interface TerminalCompletionRuntimeSlice {
  terminalCompletionIntegrationBySession: Record<string, TerminalCompletionIntegrationState>;
  terminalCommandStatusBySession: Record<string, TerminalCommandWatcherStatus>;
  setTerminalCommandStatus: (sessionId: string, status: TerminalCommandWatcherStatus) => void;
  setTerminalCompletionIntegration: (
    sessionId: string,
    integration: TerminalCompletionIntegrationState,
  ) => void;
  clearTerminalCompletionIntegration: (sessionId: string) => void;
}

export function createTerminalCompletionRuntimeSlice(
  set: (partial: Partial<TerminalCompletionRuntimeSlice>) => void,
  get: () => TerminalCompletionRuntimeSlice,
): TerminalCompletionRuntimeSlice {
  return {
    terminalCompletionIntegrationBySession: {},
    terminalCommandStatusBySession: {},
    setTerminalCommandStatus: (sessionId, status) => {
      if (get().terminalCommandStatusBySession[sessionId] === status) return;
      set({
        terminalCommandStatusBySession: {
          ...get().terminalCommandStatusBySession,
          [sessionId]: status,
        },
      });
    },
    setTerminalCompletionIntegration: (sessionId, integration) =>
      set({
        terminalCompletionIntegrationBySession: {
          ...get().terminalCompletionIntegrationBySession,
          [sessionId]: integration,
        },
      }),
    clearTerminalCompletionIntegration: (sessionId) => {
      const current = get().terminalCompletionIntegrationBySession;
      const commands = get().terminalCommandStatusBySession;
      if (!(sessionId in current) && !(sessionId in commands)) return;
      const { [sessionId]: _removed, ...remaining } = current;
      const { [sessionId]: _removedCommand, ...remainingCommands } = commands;
      set({
        terminalCompletionIntegrationBySession: remaining,
        terminalCommandStatusBySession: remainingCommands,
      });
    },
  };
}
