import { describe, expect, it, vi } from "vitest";
import type * as monaco from "monaco-editor";
import {
  isMonacoContextMenuCommand,
  MONACO_CONTEXT_MENU_COMMAND_IDS,
  runMonacoContextMenuCommand,
} from "./monacoContextMenuActions";

function createEditor() {
  const focus = vi.fn();
  const trigger = vi.fn();

  const editor = {
    focus,
    trigger,
  } as unknown as monaco.editor.IStandaloneCodeEditor;

  return { editor, focus, trigger };
}

describe("runMonacoContextMenuCommand", () => {
  it.each(Object.entries(MONACO_CONTEXT_MENU_COMMAND_IDS))(
    "dispatches %s through Monaco's command service",
    (command, commandId) => {
      const { editor, focus, trigger } = createEditor();

      runMonacoContextMenuCommand(
        editor,
        command as keyof typeof MONACO_CONTEXT_MENU_COMMAND_IDS,
      );

      expect(focus).toHaveBeenCalledOnce();
      expect(trigger).toHaveBeenCalledWith("contextMenu", commandId, {});
    },
  );
});

describe("isMonacoContextMenuCommand", () => {
  it("accepts only owned command keys", () => {
    expect(isMonacoContextMenuCommand("copy")).toBe(true);
    expect(isMonacoContextMenuCommand("save")).toBe(false);
    expect(isMonacoContextMenuCommand("toString")).toBe(false);
  });
});
