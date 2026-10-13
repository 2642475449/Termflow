import { describe, expect, it } from "vitest";
import { useTerminalDiagnosticsStore } from "./terminalDiagnosticsSlice";

describe("terminal runtime diagnostics", () => {
  it("tracks duplicate views independently and removes only the unmounted view", () => {
    const snapshot = {
      sessionId: "same-session", pendingChars: 10, bufferedChars: 0, pendingWrites: 1,
      peakPendingChars: 10, oldestWriteMs: 5, receivedChars: 10, parsedChars: 0, overloaded: false,
    };
    const { setTerminalDiagnostics } = useTerminalDiagnosticsStore.getState();
    setTerminalDiagnostics("main", snapshot);
    setTerminalDiagnostics("aux", { ...snapshot, pendingChars: 5 });
    setTerminalDiagnostics("main", null);
    expect(useTerminalDiagnosticsStore.getState().terminals).toEqual({ aux: { ...snapshot, pendingChars: 5 } });
    setTerminalDiagnostics("aux", null);
    expect(useTerminalDiagnosticsStore.getState().terminals).toEqual({});
  });
});
