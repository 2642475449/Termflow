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
    setTerminalCompletionIntegration: (sessionId, integration) =>
      set({
        terminalCompletionIntegrationBySession: {
          ...get().terminalCompletionIntegrationBySession,
          [sessionId]: integration,
        },
      }),
    clearTerminalCompletionIntegration: (sessionId) => {
      const current = get().terminalCompletionIntegrationBySession;
      if (!(sessionId in current)) return;
      const { [sessionId]: _removed, ...remaining } = current;
      set({ terminalCompletionIntegrationBySession: remaining });
    },
  };
}
