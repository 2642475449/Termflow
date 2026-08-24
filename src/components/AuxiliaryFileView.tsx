import { Alert, Button, Empty, Segmented, Spin, Tag, message } from "antd";
import { ExportOutlined, FolderOpenOutlined, PushpinOutlined } from "@ant-design/icons";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import MarkdownPreview from "@/components/markdown/MarkdownPreview";
import MonacoTextEditor from "@/components/editors/MonacoTextEditor";
import {
  inspectProjectFile,
  openInAssociatedApplication,
  readProjectFile,
  readProjectImage,
  readProjectPdf,
  writeProjectFile,
} from "@/lib/api";
import { openAuxiliaryFile } from "@/lib/auxiliaryDock";
import { replaceMarkdownSourceBlock } from "@/components/markdown/markdownSourceBlocks";
import { useAppStore } from "@/store";

const PdfPreview = lazy(() => import("@/components/pdf/PdfPreview"));

interface AuxiliaryFileViewProps {
  projectPath: string;
  path: string;
  preview: boolean;
  active: boolean;
  onPin: () => void;
  onPromoteToWorkspace: () => void;
}

const GIT_REFRESH_EVENT = "termflow:git-refresh";
const GIT_FILE_CHANGE_EVENT = "git:file-change";

function isMarkdown(path: string) {
  return /\.(md|markdown)$/i.test(path);
}

export default function AuxiliaryFileView({
  projectPath,
  path,
  preview,
  active,
  onPin,
  onPromoteToWorkspace,
}: AuxiliaryFileViewProps) {
  const { t } = useTranslation();
  const openFileTab = useAppStore((state) => state.openFileTab);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<"text" | "image" | "pdf" | "binary">("text");
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [readOnly, setReadOnly] = useState(true);
  const [markdownViewMode, setMarkdownViewMode] = useState<"edit" | "preview">("preview");
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modifiedAtMs, setModifiedAtMs] = useState<number | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const saveInFlightRef = useRef(false);

  const name = useMemo(
    () => path.split(/[\\/]/).filter(Boolean).pop() ?? path,
    [path],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent("");
    setSavedContent("");
    setReadOnly(true);
    setImageSrc(null);
    setPdfData(null);

    void inspectProjectFile(projectPath, path)
      .then(async (status) => {
        if (cancelled) return;
        setKind(status.kind);
        setReadOnly(status.readOnly);
        setModifiedAtMs(status.modifiedAtMs ?? null);
        if (status.kind === "text") {
          const file = await readProjectFile(projectPath, path);
          if (!cancelled) {
            setContent(file.content);
            setSavedContent(file.content);
            setReadOnly(file.readOnly);
            setModifiedAtMs(file.modifiedAtMs ?? status.modifiedAtMs ?? null);
          }
        } else if (status.kind === "image") {
          const image = await readProjectImage(projectPath, path);
          if (!cancelled) setImageSrc(image.dataUrl);
        } else if (status.kind === "pdf") {
          const pdf = await readProjectPdf(projectPath, path);
          if (!cancelled) setPdfData(pdf);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setModifiedAtMs(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [path, projectPath, refreshVersion]);

  useEffect(() => {
    setMarkdownViewMode("preview");
  }, [path]);

  const isDirty = kind === "text" && content !== savedContent;
  const handleSave = useCallback(async (options?: { silent?: boolean }) => {
    if (readOnly || kind !== "text" || !isDirty || saveInFlightRef.current) return true;

    saveInFlightRef.current = true;
    try {
      await writeProjectFile(projectPath, path, content);
      setSavedContent(content);
      setError(null);
      window.dispatchEvent(new CustomEvent(GIT_REFRESH_EVENT, { detail: { projectPath } }));
      if (!options?.silent) message.success(t("fileTabs.saveSuccess"));
      return true;
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : t("fileTabs.saveFailed"));
      return false;
    } finally {
      saveInFlightRef.current = false;
    }
  }, [content, isDirty, kind, path, projectPath, readOnly, t]);

  useEffect(() => {
    if (!active || !isDirty || readOnly) return;
    const timer = window.setTimeout(() => void handleSave({ silent: true }), 1500);
    return () => window.clearTimeout(timer);
  }, [active, handleSave, isDirty, readOnly]);

  const handleOpenInWorkspace = useCallback(async () => {
    if (!await handleSave({ silent: true })) return;
    openFileTab(path, { preview: false });
    onPromoteToWorkspace();
  }, [handleSave, onPromoteToWorkspace, openFileTab, path]);

  useEffect(() => {
    if (!active) return;

    let timer: number | undefined;
    const requestRefresh = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        setRefreshVersion((version) => version + 1);
      }, 180);
    };
    const handleProjectFileChange = (event: Event) => {
      const detail = (event as CustomEvent<{ projectPath?: string }>).detail;
      if (detail?.projectPath === projectPath) requestRefresh();
    };

    window.addEventListener(GIT_REFRESH_EVENT, handleProjectFileChange);
    window.addEventListener(GIT_FILE_CHANGE_EVENT, handleProjectFileChange);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener(GIT_REFRESH_EVENT, handleProjectFileChange);
      window.removeEventListener(GIT_FILE_CHANGE_EVENT, handleProjectFileChange);
    };
  }, [active, projectPath]);

  useEffect(() => {
    if (!active || loading || modifiedAtMs === null) return;

    const timer = window.setInterval(() => {
      void inspectProjectFile(projectPath, path)
        .then((status) => {
          const nextModifiedAtMs = status.modifiedAtMs ?? null;
          if (nextModifiedAtMs !== modifiedAtMs) {
            setRefreshVersion((version) => version + 1);
          }
        })
        .catch(() => {
          setRefreshVersion((version) => version + 1);
        });
    }, 3000);

    return () => window.clearInterval(timer);
  }, [active, loading, modifiedAtMs, path, projectPath]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex h-10 shrink-0 items-center gap-2 px-3"
        style={{ borderBottom: "1px solid var(--cs-border-sidebar)" }}
      >
        <span className="min-w-0 flex-1 truncate text-xs" title={path}>
          {name}
        </span>
        {preview ? (
          <Button size="small" type="text" icon={<PushpinOutlined />} onClick={onPin}>
            {t("auxiliaryDock.pin")}
          </Button>
        ) : null}
        <Button
          size="small"
          type="text"
          icon={<ExportOutlined />}
          onClick={() => { void handleOpenInWorkspace(); }}
        >
          {t("auxiliaryDock.openInWorkspace")}
        </Button>
        <Button
          size="small"
          type="text"
          icon={<FolderOpenOutlined />}
          aria-label={t("common.openInAssociatedApp")}
          onClick={() => {
            void openInAssociatedApplication(path).catch((reason) => {
              void message.error(String(reason));
            });
          }}
        />
      </div>

      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="flex h-full items-center justify-center"><Spin /></div>
        ) : kind === "pdf" ? (
          <Suspense fallback={<div className="flex h-full items-center justify-center"><Spin /></div>}>
            <PdfPreview
              data={pdfData}
              loadError={error}
              onOpenExternal={async () => {
                try {
                  await openInAssociatedApplication(path);
                } catch (reason) {
                  void message.error(String(reason));
                }
              }}
            />
          </Suspense>
        ) : error ? (
          <div className="p-4"><Alert type="error" showIcon message={error} /></div>
        ) : kind === "binary" ? (
          <div className="flex h-full items-center justify-center">
            <Empty description={t("auxiliaryDock.binaryFile")} />
          </div>
        ) : kind === "image" ? (
          <div className="flex h-full items-center justify-center overflow-auto p-4">
            {imageSrc ? <img src={imageSrc} alt={name} className="max-h-full max-w-full object-contain" /> : null}
          </div>
        ) : isMarkdown(path) ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-end gap-2 border-b border-[var(--cs-border-sidebar)] px-3 py-1.5">
              {readOnly ? <Tag>{t("fileTabs.readOnly")}</Tag> : null}
              <Segmented<"edit" | "preview">
                size="small"
                value={markdownViewMode}
                onChange={(value) => setMarkdownViewMode(value)}
                options={[
                  { value: "edit", label: t("fileTabs.markdownModeEdit") },
                  { value: "preview", label: t("fileTabs.markdownModePreview") },
                ]}
              />
            </div>
            {markdownViewMode === "preview" ? (
              <div className="app-markdown-preview-shell min-h-0 flex-1 overflow-auto p-5">
                <MarkdownPreview
                  content={content}
                  emptyText={t("fileTabs.markdownPreviewEmpty")}
                  filePath={path}
                  projectPath={projectPath}
                  className="app-markdown-preview-surface"
                  onEditBlock={readOnly ? undefined : (block, source) => {
                    setContent(replaceMarkdownSourceBlock(content, block, source));
                  }}
                  editBlockLabel={t("fileTabs.markdownEditBlock")}
                  finishEditingLabel={t("fileTabs.markdownFinishBlockEditing")}
                  cancelEditingLabel={t("fileTabs.markdownCancelBlockEditing")}
                  formattingMenuLabel={t("fileTabs.markdownFormattingMenu")}
                  headingLabel={t("fileTabs.markdownHeading")}
                  boldLabel={t("fileTabs.markdownBold")}
                  italicLabel={t("fileTabs.markdownItalic")}
                  inlineCodeLabel={t("fileTabs.markdownInlineCode")}
                  linkLabel={t("fileTabs.markdownLink")}
                  bulletListLabel={t("fileTabs.markdownBulletList")}
                  orderedListLabel={t("fileTabs.markdownOrderedList")}
                  onOpenProjectPath={(targetPath) => {
                    openAuxiliaryFile({ projectPath, path: targetPath, preview: true });
                  }}
                  onOpenExternalLink={(href) => {
                    void openInAssociatedApplication(href);
                  }}
                />
              </div>
            ) : (
              <MonacoTextEditor
                filePath={path}
                value={content}
                readOnly={readOnly}
                onChange={setContent}
                onSave={() => { void handleSave(); }}
                saveEnabled={isDirty && !readOnly}
              />
            )}
          </div>
        ) : (
          <MonacoTextEditor
            filePath={path}
            value={content}
            readOnly={readOnly}
            onChange={setContent}
            onSave={() => { void handleSave(); }}
            saveEnabled={isDirty && !readOnly}
          />
        )}
      </div>
    </div>
  );
}
