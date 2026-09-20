import { registerRichCodeTokens } from "@/lib/monaco";
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
import { useFileEditorStatusStore } from "@/store/slices/fileEditorStatus";
import type { FileRevealTarget } from "@/lib/fileNavigation";

loader.config({ monaco });
registerRichCodeTokens();

interface MonacoTextEditorProps {
  statusTabId?: string;
  filePath: string;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  onSave?: () => void;
  saveEnabled?: boolean;
  /** Receives a 0-1 scroll ratio whenever the editor scrolls. */
  onScroll?: (ratio: number) => void;
  revealTarget?: FileRevealTarget | null;
  focusOnReveal?: boolean;
}

function MonacoTextEditor({
  statusTabId,
  filePath,
  value,
  readOnly,
  onChange,
  onSave,
  saveEnabled = false,
  onScroll,
  revealTarget,
  focusOnReveal = true,
}: MonacoTextEditorProps) {
  const lightTheme = useAppStore((s) => s.lightTheme);
  const darkTheme = useAppStore((s) => s.darkTheme);
  const themeCategory = useAppStore((s) => s.themeCategory);
  const editorFontSize = useAppStore((s) => s.editorFontSize);
  const systemPrefersDark = useAppStore((s) => s.systemPrefersDark);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const statusDisposables = useRef<monaco.IDisposable[]>([]);
  useEffect(() => () => {
    statusDisposables.current.forEach((disposable) => disposable.dispose());
    statusDisposables.current = [];
    if (statusTabId) useFileEditorStatusStore.getState().removeEditorStatus(statusTabId);
  }, [statusTabId]);
  const onSaveRef = useRef(onSave);
  const saveEnabledRef = useRef(saveEnabled);
  onSaveRef.current = onSave;
  saveEnabledRef.current = saveEnabled;

  const revealLocation = (
    editorInstance: monaco.editor.IStandaloneCodeEditor,
    target: FileRevealTarget
  ) => {
    const endLineNumber = target.endLineNumber ?? target.lineNumber;
    const range = new monaco.Range(
      target.lineNumber,
      target.startColumn,
      endLineNumber,
      endLineNumber === target.lineNumber
        ? Math.max(target.startColumn, target.endColumn)
        : Math.max(1, target.endColumn)
    );
    editorInstance.setSelection(range);
    editorInstance.revealRangeInCenter(range, monaco.editor.ScrollType.Smooth);
    if (focusOnReveal) editorInstance.focus();
  };

  const revealLocationAfterLayout = (
    editorInstance: monaco.editor.IStandaloneCodeEditor,
    target: FileRevealTarget
  ) => {
    // Monaco 首次挂载时可能尚未完成布局，导致定位请求被后续的首轮布局覆盖。
    // 下一帧重新布局后再定位，确保搜索预览和文件跳转都落在目标行。
    window.requestAnimationFrame(() => {
      if (editorRef.current !== editorInstance) return;
      editorInstance.layout();
      revealLocation(editorInstance, target);
    });
  };

  useEffect(() => {
    if (editorRef.current && revealTarget) {
      revealLocation(editorRef.current, revealTarget);
    }
  }, [revealTarget, focusOnReveal]);

  const isDark = useMemo(() => {
    if (themeCategory === "system") return systemPrefersDark;
    return themeCategory === "dark";
  }, [themeCategory, lightTheme, darkTheme, systemPrefersDark]);

  const language = useMemo(() => getMonacoLanguage(filePath), [filePath]);
  const theme = useMemo(() => getMonacoThemeName(isDark), [isDark]);
  const typography = getMonacoTypography(Math.max(13, editorFontSize));

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    if (statusTabId) {
      const updateStatus = () => {
        const model = editor.getModel();
        const position = editor.getPosition();
        if (!model || !position) return;
        const options = model.getOptions();
        const languageId = model.getLanguageId();
        const languageName = monaco.languages.getLanguages().find((entry: monaco.languages.ILanguageExtensionPoint) => entry.id === languageId)?.aliases?.[0] ?? languageId;
        useFileEditorStatusStore.getState().setEditorStatus(statusTabId, {
          line: position.lineNumber, column: position.column, language: languageName,
          eol: model.getEOL() === "\r\n" ? "CRLF" : "LF",
          tabSize: options.tabSize, insertSpaces: options.insertSpaces,
        });
      };
      statusDisposables.current = [
        editor.onDidChangeCursorPosition(updateStatus),
        editor.onDidChangeModel(updateStatus),
        editor.onDidChangeModelContent(updateStatus),
        editor.onDidChangeModelOptions(updateStatus),
        editor.onDidChangeModelLanguage(updateStatus),
      ];
      updateStatus();
    }
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

    if (revealTarget) revealLocationAfterLayout(editor, revealTarget);
  };

  return (
    <MonacoContextMenu
      filePath={filePath}
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
