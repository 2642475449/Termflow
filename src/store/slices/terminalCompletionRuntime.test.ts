import { describe, expect, it } from "vitest";
import { createAppStore } from "@/store";
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

it.each([0, 7, null])("keeps exit code %s after a live terminal becomes inactive", (code) => {
  const store = createAppStore();
  store.getState().setCurrentProject({ name: "Project", path: "D:/project" });
  store.getState().addSession({ id: "terminal", name: "Terminal", path: "D:/project", createdAt: 1, active: true, agentId: "cmd" });
  store.getState().setTerminalExitCode("terminal", code);
  store.getState().updateSession("terminal", { active: false });

  expect(store.getState().terminalExitCodeBySession.terminal).toBe(code);
  expect(store.getState().tabsById.terminal).toBeDefined();
  expect(store.getState().sessions[0].active).toBe(false);
  store.getState().updateSession("terminal", { active: true });
  store.getState().clearTerminalExitCode("terminal");
  expect(store.getState().terminalExitCodeBySession.terminal).toBeUndefined();
});

it("does not persist process exit markers across application restarts", () => {
  let saved: string | null = null;
  const storage = { getItem: () => saved, setItem: (_: string, value: string) => { saved = value; }, removeItem: () => {} };
  const store = createAppStore(storage);
  store.getState().setTerminalExitCode("terminal", 1);
  expect(createAppStore(storage).getState().terminalExitCodeBySession).toEqual({});
});

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
