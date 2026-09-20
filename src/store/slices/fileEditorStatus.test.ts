import { beforeEach, expect, it } from "vitest";
import { useFileEditorStatusStore } from "./fileEditorStatus";

beforeEach(() => useFileEditorStatusStore.setState({ editors: {} }));

it("keeps split-pane cursors independent and clears unmounted editors", () => {
  const status = { line: 65, column: 28, language: "TypeScript", eol: "LF" as const, tabSize: 2, insertSpaces: true };
  const store = useFileEditorStatusStore.getState();
  store.setEditorStatus("left", status);
  store.setEditorStatus("right", { ...status, line: 8 });
  store.removeEditorStatus("left");
  expect(useFileEditorStatusStore.getState().editors).toEqual({ right: { ...status, line: 8 } });
});
