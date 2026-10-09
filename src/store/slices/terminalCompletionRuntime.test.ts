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
