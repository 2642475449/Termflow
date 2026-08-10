import { afterEach, describe, expect, it } from "vitest";
import { useAppStore } from "./index";
import type { TerminalQuickCommand } from "@/types";

function makeCommand(id: string): TerminalQuickCommand {
  return {
    id,
    label: id,
    action: "terminal-command",
    command: `echo ${id}`,
    appendEnter: true,
    scope: { type: "global" },
  };
}

describe("quick command store actions", () => {
  const initialCommands = useAppStore.getState().terminalQuickCommands;

  afterEach(() => {
    useAppStore.setState({ terminalQuickCommands: initialCommands });
  });

  it("removes only the requested command from the latest state", () => {
    const removeCommand = useAppStore.getState().removeTerminalQuickCommand;
    useAppStore.setState({
      terminalQuickCommands: [makeCommand("first"), makeCommand("second")],
    });

    removeCommand("first");

    expect(useAppStore.getState().terminalQuickCommands).toEqual([makeCommand("second")]);
  });
});
