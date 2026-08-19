import { DiffEditor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { Alert, Button, Empty } from "antd";
import {
  DownOutlined,
  ExportOutlined,
  UpOutlined,
} from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  openInAssociatedApplication,
} from "@/lib/api";
import {
  getAdjacentDiffIndex,
  getModifiedDiffTargetLine,
  type DiffNavigationDirection,
} from "@/lib/gitDiffNavigation";
import { shouldRenderGitDiffSideBySide } from "@/lib/gitDiffLayout";
import {
  disableMonacoCommandPalette,
  getMonacoLanguage,
  getMonacoThemeName,
  getMonacoTypography,
} from "@/lib/monaco";
import { useAppStore } from "@/store";
import { useTranslation } from "react-i18next";
import MonacoContextMenu from "@/components/editors/MonacoContextMenu";

loader.config({ monaco });

interface GitDiffTabViewProps {
  tabId: string;
}

function resolveProjectFilePath(projectPath: string, filePath: string) {
  const normalized = filePath.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//") || normalized.startsWith("/")) {
    return filePath;
  }
  return `${projectPath.replace(/[\\/]+$/, "")}\\${filePath.replace(/^[\\/]+/, "")}`;
}

function GitDiffTabView({ tabId }: GitDiffTabViewProps) {
  const { t } = useTranslation();
  const lightTheme = useAppStore((s) => s.lightTheme);
  const darkTheme = useAppStore((s) => s.darkTheme);
  const themeCategory = useAppStore((s) => s.themeCategory);
  const editorFontSize = useAppStore((s) => s.editorFontSize);
  const systemPrefersDark = useAppStore((s) => s.systemPrefersDark);
  const document = useAppStore((s) => s.gitDiffDocuments[tabId]);
  const currentProject = useAppStore((s) => s.currentProject);
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const diffUpdateSubscriptionRef = useRef<monaco.IDisposable | null>(null);
  const documentRef = useRef(document);
  const revealedDocumentRef = useRef<typeof document | null>(null);
  const [changeCount, setChangeCount] = useState(0);
  const [activeChangeIndex, setActiveChangeIndex] = useState(0);

  documentRef.current = document;

  const isDark = useMemo(() => {
    if (themeCategory === "system") return systemPrefersDark;
    return themeCategory === "dark";
  }, [themeCategory, lightTheme, darkTheme, systemPrefersDark]);

  const language = useMemo(
    () => (document ? getMonacoLanguage(document.path) : "plaintext"),
    [document]
  );
  const theme = useMemo(() => getMonacoThemeName(isDark), [isDark]);
  const typography = getMonacoTypography(Math.max(13, editorFontSize));

  const revealChange = useCallback((index: number) => {
    const editor = diffEditorRef.current;
    const changes = editor?.getLineChanges() ?? [];
    const change = changes[index];
    if (!editor || !change) return;

    editor.getModifiedEditor().revealLineInCenter(
      getModifiedDiffTargetLine(change),
      monaco.editor.ScrollType.Smooth,
    );
    setActiveChangeIndex(index);
  }, []);

  const handleNavigateChange = useCallback(
    (direction: DiffNavigationDirection) => {
      const nextIndex = getAdjacentDiffIndex(
        activeChangeIndex,
        changeCount,
        direction,
      );
      if (nextIndex >= 0) revealChange(nextIndex);
    },
    [activeChangeIndex, changeCount, revealChange],
  );

  const handleDiffEditorMount = useCallback(
    (editor: monaco.editor.IStandaloneDiffEditor) => {
      diffUpdateSubscriptionRef.current?.dispose();
      diffEditorRef.current = editor;
      disableMonacoCommandPalette(editor.getOriginalEditor(), monaco);
      disableMonacoCommandPalette(editor.getModifiedEditor(), monaco);

      const syncChanges = () => {
        const changes = editor.getLineChanges() ?? [];
        const nextChangeCount = changes.length;
        setChangeCount(nextChangeCount);
        setActiveChangeIndex(0);
        if (changes.length > 0 && revealedDocumentRef.current !== documentRef.current) {
          const firstChange = changes[0];
          editor.getModifiedEditor().revealLineInCenter(
            getModifiedDiffTargetLine(firstChange),
            monaco.editor.ScrollType.Immediate,
          );
          revealedDocumentRef.current = documentRef.current;
        }
      };

      diffUpdateSubscriptionRef.current = editor.onDidUpdateDiff(syncChanges);
      syncChanges();
    },
    [],
  );

  useEffect(
    () => () => {
      diffUpdateSubscriptionRef.current?.dispose();
      diffUpdateSubscriptionRef.current = null;
      diffEditorRef.current = null;
    },
    [],
  );

  if (!document) {
    return <Empty className="mt-16" description={t("sidebar.gitClickToViewDiff")} />;
  }

  if (document.isBinary) {
    return (
      <div className="flex h-full min-h-0 flex-col p-4">
        <Alert
          type="info"
          showIcon
          message={t("common.binaryUnsupported")}
          action={
            <Button
              size="small"
              type="text"
              icon={<ExportOutlined />}
              onClick={() => {
                const path = currentProject
                  ? resolveProjectFilePath(currentProject.path, document.path)
                  : document.path;
                void openInAssociatedApplication(path);
              }}
            >
              {t("common.openInAssociatedApp")}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex items-center justify-between px-3 py-2 text-[11px]"
        style={{ borderBottom: "1px solid var(--cs-border-sidebar)" }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="truncate" style={{ color: "var(--cs-text-primary)" }}>
            {document.name}
          </span>
          <span style={{ color: "var(--cs-text-tertiary)" }}>
            {document.originalLabel}
            {" -> "}
            {document.modifiedLabel}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1">
          {changeCount > 0 && (
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                type="text"
                size="small"
                icon={<UpOutlined />}
                disabled={activeChangeIndex <= 0}
                aria-label={t("sidebar.gitPreviousChange")}
                title={t("sidebar.gitPreviousChange")}
                onClick={() => handleNavigateChange("previous")}
              />
              <span
                className="min-w-[42px] text-center tabular-nums"
                style={{ color: "var(--cs-text-tertiary)" }}
              >
                {activeChangeIndex + 1} / {changeCount}
              </span>
              <Button
                type="text"
                size="small"
                icon={<DownOutlined />}
                disabled={activeChangeIndex >= changeCount - 1}
                aria-label={t("sidebar.gitNextChange")}
                title={t("sidebar.gitNextChange")}
                onClick={() => handleNavigateChange("next")}
              />
            </div>
          )}
          <span className="max-w-[38vw] truncate" style={{ color: "var(--cs-text-tertiary)" }}>
            {document.path}
          </span>
        </div>
      </div>

      <MonacoContextMenu
        className="flex-1 min-h-0"
        getEditors={() => {
          const editor = diffEditorRef.current;
          return editor
            ? [editor.getOriginalEditor(), editor.getModifiedEditor()]
            : [];
        }}
      >
        <DiffEditor
          height="100%"
          width="100%"
          language={language}
          theme={theme}
          original={document.originalContent}
          modified={document.modifiedContent}
          onMount={handleDiffEditorMount}
          options={{
            readOnly: true,
            originalEditable: false,
            contextmenu: false,
            renderSideBySide: shouldRenderGitDiffSideBySide(document.changeKind),
            automaticLayout: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            renderWhitespace: "selection",
            lineNumbers: "on",
            wordWrap: "off",
            ...typography,
          }}
        />
      </MonacoContextMenu>
    </div>
  );
}

export default GitDiffTabView;
