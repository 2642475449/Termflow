import type { editor } from "monaco-editor";

export function disposeMonacoDiffModels(diffEditor: editor.IStandaloneDiffEditor) {
  const models = diffEditor.getModel();
  // Monaco must stop observing both models before either model is disposed.
  diffEditor.setModel(null);
  models?.original.dispose();
  models?.modified.dispose();
}
