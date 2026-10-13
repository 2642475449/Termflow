import { create } from "zustand";
import type { TerminalOutputSnapshot } from "@/lib/terminalOutputMonitor";

interface TerminalDiagnosticsState {
  terminals: Record<string, TerminalOutputSnapshot & { sessionId: string }>;
  setTerminalDiagnostics: (
    runtimeId: string,
    snapshot: (TerminalOutputSnapshot & { sessionId: string }) | null,
  ) => void;
}

// 每个挂载视图独立计数，避免主区和辅助区显示同一会话时互相覆盖；不持久化。
export const useTerminalDiagnosticsStore = create<TerminalDiagnosticsState>((set) => ({
  terminals: {},
  setTerminalDiagnostics: (runtimeId, snapshot) => set((state) => {
    const terminals = { ...state.terminals };
    if (snapshot) terminals[runtimeId] = snapshot;
    else delete terminals[runtimeId];
    return { terminals };
  }),
}));
