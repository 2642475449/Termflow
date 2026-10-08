import { describe, expect, it } from "vitest";
import {
  createTerminalCompletionRuntimeSlice,
  type TerminalCompletionRuntimeSlice,
} from "./terminalCompletionRuntime";

function createRuntimeSlice(): TerminalCompletionRuntimeSlice {
  let state: TerminalCompletionRuntimeSlice;
  const set = (partial: Partial<TerminalCompletionRuntimeSlice>) => {
    Object.assign(state, partial);
  };
  state = createTerminalCompletionRuntimeSlice(set, () => state);
  return state;
}

describe("createTerminalCompletionRuntimeSlice", () => {
  it("keeps command execution separate from integration reports and clears it per session", () => {
    const state = createRuntimeSlice();
    state.setTerminalCommandStatus("terminal-1", "running");
    state.setTerminalCommandStatus("terminal-2", "running");
    state.setTerminalCommandStatus("terminal-1", "idle");
    state.setTerminalCompletionIntegration("terminal-1", {
      shell: "powershell", status: "available", updatedAt: 100,
    });
    expect(state.terminalCommandStatusBySession).toEqual({ "terminal-1": "idle", "terminal-2": "running" });
    state.clearTerminalCompletionIntegration("terminal-1");
    expect(state.terminalCommandStatusBySession).toEqual({ "terminal-2": "running" });
    state.clearTerminalCompletionIntegration("terminal-2");
    expect(state.terminalCommandStatusBySession).toEqual({});
  });

  it("keeps integration state per terminal session and clears it when requested", () => {
    const state = createRuntimeSlice();
    state.setTerminalCompletionIntegration("terminal-1", {
      shell: "powershell",
      status: "available",
      version: "1",
      updatedAt: 100,
    });

    expect(state.terminalCompletionIntegrationBySession["terminal-1"]).toMatchObject({
      shell: "powershell",
      status: "available",
    });

    state.clearTerminalCompletionIntegration("terminal-1");
    expect(state.terminalCompletionIntegrationBySession).toEqual({});
  });
});
