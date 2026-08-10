import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useEffect, useMemo, useRef } from "react";
import MonacoContextMenu from "@/components/editors/MonacoContextMenu";
import {
  disableMonacoCommandPalette,
  getMonacoLanguage,
  getMonacoThemeName,
  getMonacoTypography,
} from "@/lib/monaco";
import { useAppStore } from "@/store";
import type { FileRevealTarget } from "@/lib/fileNavigation";

loader.config({ monaco });

interface MonacoTextEditorProps {
  filePath: string;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  onSave?: () => void;
  saveEnabled?: boolean;
  /** Receives a 0-1 scroll ratio whenever the editor scrolls. */
  onScroll?: (ratio: number) => void;
  revealTarget?: FileRevealTarget | null;
}

function MonacoTextEditor({
  filePath,
  value,
  readOnly,
  onChange,
  onSave,
  saveEnabled = false,
  onScroll,
  revealTarget,
}: MonacoTextEditorProps) {
  const lightTheme = useAppStore((s) => s.lightTheme);
  const darkTheme = useAppStore((s) => s.darkTheme);
  const themeCategory = useAppStore((s) => s.themeCategory);
  const editorFontSize = useAppStore((s) => s.editorFontSize);
  const systemPrefersDark = useAppStore((s) => s.systemPrefersDark);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onSaveRef = useRef(onSave);
  const saveEnabledRef = useRef(saveEnabled);
  onSaveRef.current = onSave;
  saveEnabledRef.current = saveEnabled;

  const revealLocation = (
    editorInstance: monaco.editor.IStandaloneCodeEditor,
    target: FileRevealTarget
  ) => {
    const range = new monaco.Range(
      target.lineNumber,
      target.startColumn,
      target.lineNumber,
      Math.max(target.startColumn, target.endColumn)
    );
    editorInstance.setSelection(range);
    editorInstance.revealRangeInCenter(range, monaco.editor.ScrollType.Smooth);
    editorInstance.focus();
  };

  useEffect(() => {
    if (editorRef.current && revealTarget) {
      revealLocation(editorRef.current, revealTarget);
    }
  }, [revealTarget]);

  const isDark = useMemo(() => {
    if (themeCategory === "system") return systemPrefersDark;
    return themeCategory === "dark";
  }, [themeCategory, lightTheme, darkTheme, systemPrefersDark]);

  const language = useMemo(() => getMonacoLanguage(filePath), [filePath]);
  const theme = useMemo(() => getMonacoThemeName(isDark), [isDark]);
  const typography = getMonacoTypography(Math.max(13, editorFontSize));

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    disableMonacoCommandPalette(editor, monaco);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (saveEnabledRef.current) onSaveRef.current?.();
    });

    if (onScroll) {
      editor.onDidScrollChange((e) => {
        if (!e.scrollTopChanged) return;
        const scrollHeight = e.scrollHeight - editor.getLayoutInfo().height;
        if (scrollHeight <= 0) {
          onScroll(0);
          return;
        }
        onScroll(Math.min(1, Math.max(0, e.scrollTop / scrollHeight)));
      });
    }

    if (revealTarget) {
      revealLocation(editor, revealTarget);
    }
  };

  return (
    <MonacoContextMenu
      className="flex-1 min-h-0 w-full"
      getEditors={() => (editorRef.current ? [editorRef.current] : [])}
      saveAction={
        onSave
          ? {
              enabled: saveEnabled,
              run: onSave,
            }
          : undefined
      }
    >
      <Editor
        height="100%"
        width="100%"
        loading={null}
        path={filePath}
        language={language}
        theme={theme}
        value={value}
        onMount={handleMount}
        onChange={(nextValue) => onChange(nextValue ?? "")}
        options={{
          automaticLayout: true,
          contextmenu: false,
          minimap: { enabled: false },
          readOnly,
          wordWrap: "off",
          smoothScrolling: true,
          scrollBeyondLastLine: false,
          renderWhitespace: "selection",
          lineNumbers: "on",
          tabSize: 2,
          insertSpaces: true,
          ...typography,
          padding: {
            top: 12,
            bottom: 12,
          },
        }}
      />
    </MonacoContextMenu>
  );
}

export default MonacoTextEditor;
