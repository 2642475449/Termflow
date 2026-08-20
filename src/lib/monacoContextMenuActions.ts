import type * as monaco from "monaco-editor";

export const MONACO_CONTEXT_MENU_COMMAND_IDS = {
  undo: "undo",
  redo: "redo",
  cut: "editor.action.clipboardCutAction",
  copy: "editor.action.clipboardCopyAction",
  paste: "editor.action.clipboardPasteAction",
  selectAll: "editor.action.selectAll",
} as const;

export type MonacoContextMenuCommand = keyof typeof MONACO_CONTEXT_MENU_COMMAND_IDS;

export function isMonacoContextMenuCommand(
  value: string,
): value is MonacoContextMenuCommand {
  return Object.prototype.hasOwnProperty.call(MONACO_CONTEXT_MENU_COMMAND_IDS, value);
}

export function runMonacoContextMenuCommand(
  editor: monaco.editor.IStandaloneCodeEditor,
  command: MonacoContextMenuCommand,
): void {
  // Monaco registers these IDs as MultiCommands, not EditorActions. Calling
  // getAction() therefore returns null; trigger() deliberately falls through
  // to Monaco's command service when no editor action owns the ID.
  editor.focus();
  editor.trigger("contextMenu", MONACO_CONTEXT_MENU_COMMAND_IDS[command], {});
}
