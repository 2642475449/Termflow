import { DiffEditor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { Alert, Button, Empty, message } from "antd";
import {
  CheckOutlined,
  DownOutlined,
  ExportOutlined,
  LoadingOutlined,
  MinusOutlined,
  UpOutlined,
} from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  gitDiffContent,
  gitDiffHunks,
  gitStageHunk,
  gitUnstageHunk,
  openInAssociatedApplication,
} from "@/lib/api";
import {
  findClosestGitHunkIndex,
  getAdjacentDiffIndex,
  getModifiedDiffTargetLine,
  type DiffNavigationDirection,
} from "@/lib/gitDiffNavigation";
import { requestGitStatusRefresh } from "@/lib/gitStatusEvents";
import {
  disableMonacoCommandPalette,
  getMonacoLanguage,
  getMonacoThemeName,
  getMonacoTypography,
} from "@/lib/monaco";
import { useAppStore } from "@/store";
import type { GitDiffHunk } from "@/types";
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
  const openGitDiffTab = useAppStore((s) => s.openGitDiffTab);
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const diffUpdateSubscriptionRef = useRef<monaco.IDisposable | null>(null);
  const [changeCount, setChangeCount] = useState(0);
  const [activeChangeIndex, setActiveChangeIndex] = useState(0);
  const [hunks, setHunks] = useState<GitDiffHunk[]>([]);
  const [hunksLoading, setHunksLoading] = useState(false);
  const [hunkOperating, setHunkOperating] = useState(false);

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
  const activeHunk = useMemo(() => {
    const lineChange = diffEditorRef.current?.getLineChanges()?.[activeChangeIndex];
    if (!lineChange) return hunks.length === 1 ? hunks[0] : null;
    const hunkIndex = findClosestGitHunkIndex(lineChange, hunks);
    return hunkIndex >= 0 ? hunks[hunkIndex] : null;
  }, [activeChangeIndex, changeCount, hunks]);

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
        const nextChangeCount = editor.getLineChanges()?.length ?? 0;
        setChangeCount(nextChangeCount);
        setActiveChangeIndex(0);
        if (nextChangeCount > 0) {
          void editor.revealFirstDiff();
        }
      };

      diffUpdateSubscriptionRef.current = editor.onDidUpdateDiff(syncChanges);
      syncChanges();
      void editor.revealFirstDiff();
    },
    [],
  );

  useEffect(() => {
    setActiveChangeIndex(0);
    if (diffEditorRef.current) {
      void diffEditorRef.current.revealFirstDiff();
    }
  }, [document]);

  useEffect(() => {
    let cancelled = false;
    if (
      !document
      || document.isBinary
      || !document.hunkActionsAvailable
      || !currentProject
    ) {
      setHunks([]);
      setHunksLoading(false);
      return;
    }

    setHunksLoading(true);
    void gitDiffHunks(currentProject.path, document.path, document.staged)
      .then((result) => {
        if (!cancelled) setHunks(result.hunks);
      })
      .catch((error) => {
        if (cancelled) return;
        setHunks([]);
        message.error(
          `${t("sidebar.gitLoadHunksFailed")}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        if (!cancelled) setHunksLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    currentProject,
    document,
    t,
  ]);

  const handleToggleCurrentHunk = useCallback(async () => {
    if (!currentProject || !document || !activeHunk || hunkOperating) return;

    const operation = document.staged ? gitUnstageHunk : gitStageHunk;
    const successKey = document.staged
      ? "sidebar.gitUnstageHunkSuccess"
      : "sidebar.gitStageHunkSuccess";
    const failureKey = document.staged
      ? "sidebar.gitUnstageHunkFailed"
      : "sidebar.gitStageHunkFailed";

    setHunkOperating(true);
    try {
      await operation(currentProject.path, document.path, activeHunk.header);
      message.success(t(successKey));
      requestGitStatusRefresh(currentProject.path);
    } catch (error) {
      message.error(
        `${t(failureKey)}: ${error instanceof Error ? error.message : String(error)}`,
      );
      setHunkOperating(false);
      return;
    }

    try {
      const refreshed = await gitDiffContent(
        currentProject.path,
        document.path,
        document.staged,
        document.oldPath,
      );
      openGitDiffTab({
        ...document,
        path: refreshed.filePath,
        originalContent: refreshed.originalContent,
        modifiedContent: refreshed.modifiedContent,
        originalLabel: refreshed.originalLabel,
        modifiedLabel: refreshed.modifiedLabel,
        isBinary: refreshed.isBinary,
      });
    } catch (error) {
      console.error("Failed to refresh Git diff after hunk operation:", error);
      message.warning(t("sidebar.gitDiffRefreshFailed"));
    } finally {
      setHunkOperating(false);
    }
  }, [
    activeHunk,
    currentProject,
    document,
    hunkOperating,
    openGitDiffTab,
    t,
  ]);

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
                disabled={hunkOperating || activeChangeIndex <= 0}
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
                disabled={hunkOperating || activeChangeIndex >= changeCount - 1}
                aria-label={t("sidebar.gitNextChange")}
                title={t("sidebar.gitNextChange")}
                onClick={() => handleNavigateChange("next")}
              />
              {document.hunkActionsAvailable && (hunksLoading || activeHunk) && (
                <Button
                  type="text"
                  size="small"
                  loading={hunkOperating}
                  disabled={hunksLoading || !activeHunk}
                  icon={
                    hunksLoading
                      ? <LoadingOutlined />
                      : document.staged
                        ? <MinusOutlined />
                        : <CheckOutlined />
                  }
                  onClick={() => void handleToggleCurrentHunk()}
                >
                  {t(
                    document.staged
                      ? "sidebar.gitUnstageHunk"
                      : "sidebar.gitStageHunk",
                  )}
                </Button>
              )}
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
            renderSideBySide: true,
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
