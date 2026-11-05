import type { DiffEditorProps } from "@monaco-editor/react";
import { useLayoutEffect, useRef } from "react";
import * as monaco from "@/lib/monacoRuntime";
import { disposeMonacoDiffModels } from "@/lib/disposeMonacoDiffModels";

type MonacoDiffEditorProps = Pick<DiffEditorProps,
  "original" | "modified" | "language" | "theme" | "options" | "onMount" | "height" | "width"
>;

// Own the models and editor together: @monaco-editor/react 4.x disposes
// attached models first, which triggers Monaco's diff-widget assertion.
export function MonacoDiffEditor(props: MonacoDiffEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const initialProps = useRef(props);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const initial = initialProps.current;
    const instance = monaco.editor.createDiffEditor(container, initial.options);
    editorRef.current = instance;
    let original: monaco.editor.ITextModel | undefined;
    let modified: monaco.editor.ITextModel | undefined;
    const dispose = () => {
      editorRef.current = null;
      try {
        disposeMonacoDiffModels(instance);
      } finally {
        instance.dispose();
        // Also release partially initialized models if mounting failed.
        if (original && !original.isDisposed()) original.dispose();
        if (modified && !modified.isDisposed()) modified.dispose();
      }
    };
    try {
      original = monaco.editor.createModel(initial.original ?? "", initial.language);
      modified = monaco.editor.createModel(initial.modified ?? "", initial.language);
      instance.setModel({ original, modified });
      initial.onMount?.(instance, monaco);
    } catch (error) {
      dispose();
      throw error;
    }
    return dispose;
  }, []);

  useLayoutEffect(() => {
    const models = editorRef.current?.getModel();
    if (!models) return;
    if (models.original.getValue() !== (props.original ?? "")) models.original.setValue(props.original ?? "");
    if (models.modified.getValue() !== (props.modified ?? "")) models.modified.setValue(props.modified ?? "");
  }, [props.original, props.modified]);

  useLayoutEffect(() => {
    const models = editorRef.current?.getModel();
    if (!models) return;
    monaco.editor.setModelLanguage(models.original, props.language ?? "plaintext");
    monaco.editor.setModelLanguage(models.modified, props.language ?? "plaintext");
  }, [props.language]);

  useLayoutEffect(() => {
    if (props.options) editorRef.current?.updateOptions(props.options);
  }, [props.options]);

  useLayoutEffect(() => {
    if (props.theme) monaco.editor.setTheme(props.theme);
  }, [props.theme]);

  return <div ref={containerRef} style={{ height: props.height ?? "100%", width: props.width ?? "100%", minHeight: 0 }} />;
}
