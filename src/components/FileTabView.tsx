import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Dropdown, Empty, Segmented, Spin, Tag, message } from "antd";
import {
  EllipsisOutlined,
  FileImageOutlined,
  FileMarkdownOutlined,
  FileOutlined,
  RightOutlined,
} from "@ant-design/icons";
import {
  openInAssociatedApplication,
  inspectProjectFile,
  readProjectImage,
  readProjectFile,
  readProjectPdf,
  writeProjectFile,
} from "@/lib/api";
import MonacoTextEditor from "@/components/editors/MonacoTextEditor";
import {
  consumePendingFileNavigation,
  FILE_NAVIGATION_EVENT,
  isNavigationForPath,
  type FileNavigationRequest,
  type FileRevealTarget,
} from "@/lib/fileNavigation";
import MarkdownPreview from "@/components/markdown/MarkdownPreview";
import { replaceMarkdownSourceBlock } from "@/components/markdown/markdownSourceBlocks";
import { revealExplorerPath } from "@/lib/explorer";
import { stripAnsiEscapeSequences } from "@/lib/textContent";
import { supportsOfficePreview } from "@/lib/officePreview";
import { useAppStore } from "@/store";
import { useTranslation } from "react-i18next";

type FileKind = "text" | "image" | "pdf" | "binary";
const AUTO_SAVE_IDLE_MS = 1500;
const MAX_VISIBLE_BREADCRUMB_ITEMS = 4;

interface FileTabViewProps {
  tabId: string;
  projectPath: string;
  path: string;
  isActive: boolean;
}

const GIT_REFRESH_EVENT = "termflow:git-refresh";
const PdfPreview = lazy(() => import("@/components/pdf/PdfPreview"));
const OfficeFilePreview = lazy(() => import("@/components/documents/OfficeFilePreview"));

interface FileBreadcrumbItem {
  label: string;
  path: string;
  kind: "file" | "directory";
}

type MarkdownViewMode = "edit" | "preview";

function inferFileKind(path: string): FileKind {
  const normalizedPath = path.replace(/[\\/]+$/, "");
  const fileName = normalizedPath.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "pdf") {
    return "pdf";
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(extension)) {
    return "image";
  }
  if (
    [
      "txt",
      "md",
      "json",
      "js",
      "jsx",
      "ts",
      "tsx",
      "rs",
      "css",
      "scss",
      "html",
      "htm",
      "xml",
      "yml",
      "yaml",
      "toml",
      "sh",
      "ps1",
      "bat",
      "env",
      "log",
      "csv",
      "sql",
      "py",
      "java",
      "go",
      "c",
      "cpp",
      "h",
      "hpp",
    ].includes(extension)
  ) {
    return "text";
  }
  return "binary";
}

function isMarkdownFile(path: string) {
  const normalizedPath = path.replace(/[\\/]+$/, "");
  const fileName = normalizedPath.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return extension === "md" || extension === "markdown";
}

function formatFileSize(sizeBytes: number | null): string | null {
  if (sizeBytes === null || !Number.isFinite(sizeBytes)) {
    return null;
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = sizeBytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const digits = unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

function joinPath(basePath: string, segments: string[]): string {
  const separator = basePath.includes("\\") ? "\\" : "/";
  const normalizedBasePath = basePath.replace(/[\\/]+$/, "");
  if (segments.length === 0) {
    return normalizedBasePath;
  }

  return [normalizedBasePath, ...segments].join(separator);
}

function buildFileBreadcrumbs(projectPath: string, filePath: string): FileBreadcrumbItem[] {
  const normalizedProjectPath = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedFilePath = filePath.replace(/\\/g, "/");
  const projectPrefix = `${normalizedProjectPath}/`;

  if (!normalizedFilePath.startsWith(projectPrefix)) {
    const fallbackLabel = filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
    return [
      {
        label: fallbackLabel,
        path: filePath,
        kind: "file",
      },
    ];
  }

  const relativePath = normalizedFilePath.slice(normalizedProjectPath.length + 1);
  const segments = relativePath.split("/").filter(Boolean);

  return segments.map((segment, index) => ({
    label: segment,
    path: joinPath(projectPath, segments.slice(0, index + 1)),
    kind: index === segments.length - 1 ? "file" : "directory",
  }));
}

function collapseBreadcrumbs(items: FileBreadcrumbItem[]) {
  if (items.length <= MAX_VISIBLE_BREADCRUMB_ITEMS) {
    return {
      leadingItems: items,
      hiddenItems: [] as FileBreadcrumbItem[],
      trailingItems: [] as FileBreadcrumbItem[],
    };
  }

  return {
    leadingItems: items.slice(0, 1),
    hiddenItems: items.slice(1, -2),
    trailingItems: items.slice(-2),
  };
}

function FileTabView({ tabId, projectPath, path, isActive }: FileTabViewProps) {
  const { t } = useTranslation();
  const registerFileDocument = useAppStore((s) => s.registerFileDocument);
  const setTabDirty = useAppStore((s) => s.setTabDirty);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const setActiveSidebarSection = useAppStore((s) => s.setActiveSidebarSection);
  const openFileTab = useAppStore((s) => s.openFileTab);
  const promoteTab = useAppStore((s) => s.promoteTab);
  const tab = useAppStore((s) => s.tabsById[tabId]);
  const fileDocument = useAppStore((s) => s.fileDocuments[path]);

  const [kind, setKind] = useState<FileKind>(fileDocument?.kind ?? inferFileKind(path));
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState("");
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  const [savedContent, setSavedContent] = useState("");
  const [readOnly, setReadOnly] = useState(fileDocument?.readOnly ?? false);
  const [sizeBytes, setSizeBytes] = useState<number | null>(fileDocument?.sizeBytes ?? null);
  const [largeFile, setLargeFile] = useState(fileDocument?.largeFile ?? false);
  const [modifiedAtMs, setModifiedAtMs] = useState<number | null>(
    fileDocument?.modifiedAtMs ?? null
  );
  const [error, setError] = useState<string | null>(null);
  const [markdownViewMode, setMarkdownViewMode] = useState<MarkdownViewMode>("preview");
  const [revealTarget, setRevealTarget] = useState<FileRevealTarget | null>(() =>
    consumePendingFileNavigation(path)
  );
  const isDirty = tab?.dirty ?? false;
  const markdownFile = isMarkdownFile(path);
  const saveInFlightRef = useRef(false);
  const wasActiveRef = useRef(isActive);

  // 滚动位置记忆
  const previewScrollTopRef = useRef<number>(0);
  const editorScrollTopRef = useRef<number>(0);
  const previewContainerRef = useRef<HTMLDivElement | null>(null);

  // 保存预览区滚动位置
  const handlePreviewScroll = useCallback(() => {
    if (previewContainerRef.current) {
      previewScrollTopRef.current = previewContainerRef.current.scrollTop;
    }
  }, []);

  // 恢复滚动位置
  useEffect(() => {
    if (markdownViewMode === "preview" && previewContainerRef.current) {
      requestAnimationFrame(() => {
        if (previewContainerRef.current) {
          previewContainerRef.current.scrollTop = previewScrollTopRef.current;
        }
      });
    }
    // 编辑器的滚动位置由 MonacoTextEditor 的 onScroll 回调保存为比例
    // 恢复需要通过 Monaco Editor API，这里暂时不处理
    // 因为 Monaco Editor 会在组件挂载时自动恢复状态
  }, [markdownViewMode]);

  // 重置滚动位置（切换文件时）
  useEffect(() => {
    previewScrollTopRef.current = 0;
    editorScrollTopRef.current = 0;
  }, [path]);

  useEffect(() => {
    setMarkdownViewMode("preview");
  }, [path]);

  useEffect(() => {
    if (revealTarget) {
      setMarkdownViewMode("edit");
    }
  }, [revealTarget]);

  useEffect(() => {
    const pending = consumePendingFileNavigation(path);
    if (pending) {
      setRevealTarget(pending);
      setMarkdownViewMode("edit");
    }

    const handleNavigation = (event: Event) => {
      const request = (event as CustomEvent<FileNavigationRequest>).detail;
      if (!request || !isNavigationForPath(request.path, path)) return;
      consumePendingFileNavigation(path);
      setRevealTarget(request);
      setMarkdownViewMode("edit");
    };
    window.addEventListener(FILE_NAVIGATION_EVENT, handleNavigation);
    return () => window.removeEventListener(FILE_NAVIGATION_EVENT, handleNavigation);
  }, [path]);

  const loadFile = useCallback(async () => {
    setLoading(true);
    setError(null);
    let nextKind = inferFileKind(path);
    try {
      const status = await inspectProjectFile(projectPath, path);
      nextKind = status.kind;
      setKind(status.kind);
      setReadOnly(status.readOnly);
      setSizeBytes(status.sizeBytes ?? null);
      setLargeFile(status.largeFile ?? false);
      setModifiedAtMs(status.modifiedAtMs ?? null);
      registerFileDocument({
        path: status.path,
        name: status.name,
        kind: status.kind,
        readOnly: status.readOnly,
        sizeBytes: status.sizeBytes ?? null,
        largeFile: status.largeFile ?? false,
        modifiedAtMs: status.modifiedAtMs ?? null,
      });

      if (status.kind === "text") {
        const result = await readProjectFile(projectPath, path);
        const textContent = stripAnsiEscapeSequences(result.content);
        setContent(textContent);
        setImageSrc(null);
        setPdfData(null);
        setImageLoadFailed(false);
        setSavedContent(textContent);
        setReadOnly(result.readOnly);
        setSizeBytes(result.sizeBytes ?? status.sizeBytes ?? null);
        setLargeFile(result.largeFile ?? status.largeFile ?? false);
        setModifiedAtMs(result.modifiedAtMs ?? status.modifiedAtMs ?? null);
        registerFileDocument({
          path: result.path,
          name: result.name,
          kind: result.kind,
          readOnly: result.readOnly,
          sizeBytes: result.sizeBytes ?? null,
          largeFile: result.largeFile ?? false,
          modifiedAtMs: result.modifiedAtMs ?? null,
        });
        setTabDirty(tabId, false);
        return;
      }

      if (status.kind === "image") {
        const result = await readProjectImage(projectPath, path);
        setImageSrc(result.dataUrl);
        setPdfData(null);
        setImageLoadFailed(false);
        setContent("");
        setSavedContent("");
        setSizeBytes(result.sizeBytes ?? status.sizeBytes ?? null);
        setLargeFile(status.largeFile ?? false);
        setTabDirty(tabId, false);
        return;
      }

      if (status.kind === "pdf") {
        setContent("");
        setImageSrc(null);
        setImageLoadFailed(false);
        setSavedContent("");
        try {
          setPdfData(await readProjectPdf(projectPath, path));
        } catch (reason) {
          setPdfData(null);
          setError(reason instanceof Error ? reason.message : String(reason));
        }
        setTabDirty(tabId, false);
        return;
      }

      setContent("");
      setImageSrc(null);
      setPdfData(null);
      setImageLoadFailed(false);
      setSavedContent("");
      setSizeBytes(status.sizeBytes ?? null);
      setLargeFile(status.largeFile ?? false);
      setTabDirty(tabId, false);
    } catch (nextError) {
      const nextMessage =
        typeof nextError === "string"
          ? nextError
          : nextError instanceof Error
            ? nextError.message
            : t("fileTabs.openFailed");
      setError(nextMessage);
      setReadOnly(true);
      setKind(nextKind);
      setSizeBytes(null);
      setLargeFile(false);
      setImageSrc(null);
      setPdfData(null);
      setImageLoadFailed(false);
      setContent("");
      setSavedContent("");
    } finally {
      setLoading(false);
    }
  }, [path, projectPath, registerFileDocument, setTabDirty, t, tabId]);

  useEffect(() => {
    void loadFile();
  }, [loadFile]);

  const handleSave = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    if (readOnly || kind !== "text" || !isDirty || saveInFlightRef.current) {
      return false;
    }

    saveInFlightRef.current = true;
    try {
      await writeProjectFile(projectPath, path, content);
      const status = await inspectProjectFile(projectPath, path);
      setSavedContent(content);
      setTabDirty(tabId, false);
      setReadOnly(status.readOnly);
      setSizeBytes(status.sizeBytes ?? null);
      setLargeFile(status.largeFile ?? false);
      setModifiedAtMs(status.modifiedAtMs ?? null);
      registerFileDocument({
        path: status.path,
        name: status.name,
        kind: status.kind,
        readOnly: status.readOnly,
        sizeBytes: status.sizeBytes ?? null,
        largeFile: status.largeFile ?? false,
        modifiedAtMs: status.modifiedAtMs ?? null,
      });
      setKind(status.kind);
      setError(null);
      window.dispatchEvent(
        new CustomEvent(GIT_REFRESH_EVENT, {
          detail: { projectPath },
        })
      );
      if (!silent) {
        message.success(t("fileTabs.saveSuccess"));
      }
      return true;
    } catch (nextError) {
      message.error(nextError instanceof Error ? nextError.message : t("fileTabs.saveFailed"));
      return false;
    } finally {
      saveInFlightRef.current = false;
    }
  }, [
    content,
    isDirty,
    kind,
    message,
    path,
    projectPath,
    readOnly,
    registerFileDocument,
    setTabDirty,
    t,
    tabId,
  ]);

  useEffect(() => {
    if (
      !isActive ||
      loading ||
      kind !== "text" ||
      readOnly ||
      !isDirty
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      void handleSave({ silent: true });
    }, AUTO_SAVE_IDLE_MS);

    return () => window.clearTimeout(timer);
  }, [content, handleSave, isActive, isDirty, kind, loading, readOnly]);

  useEffect(() => {
    if (
      wasActiveRef.current &&
      !isActive &&
      kind === "text" &&
      !readOnly &&
      isDirty
    ) {
      void handleSave({ silent: true });
    }
    wasActiveRef.current = isActive;
  }, [handleSave, isActive, isDirty, kind, readOnly]);

  useEffect(() => {
    if (!isActive || kind !== "text" || readOnly) {
      return;
    }

    const handleWindowBlur = () => {
      if (useAppStore.getState().tabsById[tabId]?.dirty) {
        void handleSave({ silent: true });
      }
    };

    window.addEventListener("blur", handleWindowBlur);
    return () => window.removeEventListener("blur", handleWindowBlur);
  }, [handleSave, isActive, kind, readOnly, tabId]);

  useEffect(() => {
    if (!isActive || loading || !modifiedAtMs) {
      return;
    }

    const timer = window.setInterval(() => {
      inspectProjectFile(projectPath, path)
        .then((status) => {
          const nextModifiedAtMs = status.modifiedAtMs ?? null;
          if (nextModifiedAtMs !== null && nextModifiedAtMs !== modifiedAtMs) {
            void loadFile();
          }
        })
        .catch(() => {
          void loadFile();
        });
    }, 3000);

    return () => window.clearInterval(timer);
  }, [
    isActive,
    loadFile,
    loading,
    modifiedAtMs,
    path,
    projectPath,
  ]);

  function handleEditorChange(value: string) {
    setContent(value);
    setTabDirty(tabId, value !== savedContent);
    if (tab?.preview) {
      promoteTab(tabId);
    }
  }

  const fileSizeLabel = formatFileSize(sizeBytes);
  const breadcrumbs = useMemo(() => buildFileBreadcrumbs(projectPath, path), [path, projectPath]);
  const collapsedBreadcrumbs = useMemo(() => collapseBreadcrumbs(breadcrumbs), [breadcrumbs]);
  const handleRevealBreadcrumb = useCallback(
    (targetPath: string, targetKind: "file" | "directory") => {
      setSidebarCollapsed(false);
      setActiveSidebarSection("project");

      const dispatchReveal = () => revealExplorerPath(targetPath, targetKind);
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(dispatchReveal);
        });
        return;
      }

      window.setTimeout(dispatchReveal, 32);
    },
    [setActiveSidebarSection, setSidebarCollapsed]
  );
  const handleOpenExternalLink = useCallback(async (href: string) => {
    try {
      await openInAssociatedApplication(href);
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("fileTabs.openFailed"));
    }
  }, [t]);
  const handleOpenProjectMarkdownPath = useCallback((targetPath: string) => {
    openFileTab(targetPath);
  }, [openFileTab]);
  const collapsedBreadcrumbMenuItems = useMemo(
    () =>
      collapsedBreadcrumbs.hiddenItems.map((item) => ({
        key: item.path,
        label: item.label,
        onClick: () => handleRevealBreadcrumb(item.path, item.kind),
      })),
    [collapsedBreadcrumbs.hiddenItems, handleRevealBreadcrumb]
  );
  const visibleBreadcrumbs = useMemo(
    () => [...collapsedBreadcrumbs.leadingItems, ...collapsedBreadcrumbs.trailingItems],
    [collapsedBreadcrumbs.leadingItems, collapsedBreadcrumbs.trailingItems]
  );
  const breadcrumbNode = (
    <div className="min-w-0 flex-1 overflow-x-auto" title={path}>
      <div className="flex min-w-max items-center gap-1 text-[13px] text-[var(--cs-text-secondary)]">
        {visibleBreadcrumbs.map((item, index) => {
          const shouldInsertCollapsedMenu =
            index === collapsedBreadcrumbs.leadingItems.length &&
            collapsedBreadcrumbs.hiddenItems.length > 0;
          const isCurrent = item.path === breadcrumbs[breadcrumbs.length - 1]?.path;
          return (
            <Fragment key={`${item.path}-${item.kind}`}>
              {(index > 0 || shouldInsertCollapsedMenu) && (
                <RightOutlined className="text-[10px] text-[var(--cs-text-quaternary)]" />
              )}
              {shouldInsertCollapsedMenu && (
                <Fragment>
                  <Dropdown menu={{ items: collapsedBreadcrumbMenuItems }} trigger={["click"]}>
                    <button
                      type="button"
                      className="rounded bg-transparent border-0 px-1 py-0.5 leading-none text-[var(--cs-text-secondary)] transition-colors hover:text-[var(--cs-primary)]"
                      title={collapsedBreadcrumbs.hiddenItems.map((segment) => segment.label).join(" \\ ")}
                    >
                      <EllipsisOutlined />
                    </button>
                  </Dropdown>
                  <RightOutlined className="text-[10px] text-[var(--cs-text-quaternary)]" />
                </Fragment>
              )}
              <button
                type="button"
                className={`rounded bg-transparent border-0 px-1 py-0.5 leading-none transition-colors ${
                  isCurrent
                    ? "text-[var(--cs-text-primary)] hover:text-[var(--cs-primary)]"
                    : "text-[var(--cs-text-secondary)] hover:text-[var(--cs-primary)]"
                }`}
                onClick={() => handleRevealBreadcrumb(item.path, item.kind)}
              >
                {item.label}
              </button>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
  const largeFileAlert =
    kind === "text" && largeFile ? (
      <div className="px-4 pt-3">
        <Alert
          type="info"
          showIcon
          message={t("fileTabs.largeFileReadOnly", { size: fileSizeLabel ?? "--" })}
        />
      </div>
    ) : null;

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Spin tip={t("fileTabs.loading")} />
      </div>
    );
  }

  if (kind === "image") {
    return (
      <div className="h-full flex flex-col min-h-0">
        <div
          className="px-4 py-2 flex items-center gap-3"
          style={{ borderBottom: "1px solid var(--cs-border-sidebar)" }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <FileImageOutlined />
            {breadcrumbNode}
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-6 flex items-center justify-center">
          {imageSrc && !imageLoadFailed ? (
            <img
              src={imageSrc}
              alt={fileDocument?.name ?? path}
              className="max-w-full max-h-full object-contain"
              onError={() => setImageLoadFailed(true)}
            />
          ) : (
            <Empty description={error ?? "图片加载失败"} />
          )}
        </div>
      </div>
    );
  }

  if (kind === "pdf") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">
          <Suspense fallback={<div className="flex h-full items-center justify-center"><Spin /></div>}>
            <PdfPreview
              data={pdfData}
              loadError={error}
              onOpenExternal={() => handleOpenExternalLink(path)}
            />
          </Suspense>
        </div>
      </div>
    );
  }

  if (kind === "binary") {
    if (supportsOfficePreview(path)) {
      return (
        <Suspense fallback={<div className="flex h-full items-center justify-center"><Spin /></div>}>
          <OfficeFilePreview projectPath={projectPath} path={path} />
        </Suspense>
      );
    }

    return (
      <div className="h-full flex items-center justify-center px-6">
        <div className="w-full flex flex-col">
          <div className="h-full flex items-center justify-center px-6">
            <Empty
              image={<FileOutlined style={{ fontSize: 48, color: "var(--cs-text-tertiary)" }} />}
              description={error ?? t("fileTabs.binaryUnsupported")}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      {largeFileAlert}
      <div
        className="px-4 py-2 flex items-center gap-3"
        style={{ borderBottom: "1px solid var(--cs-border-sidebar)" }}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {markdownFile ? <FileMarkdownOutlined /> : <FileOutlined />}
          {breadcrumbNode}
          {readOnly && <Tag>{t("fileTabs.readOnly")}</Tag>}
          {largeFile && <Tag>{t("fileTabs.largeFile")}</Tag>}
        </div>
        {markdownFile && !error ? (
          <Segmented<MarkdownViewMode>
            size="small"
            value={markdownViewMode}
            onChange={(value) => setMarkdownViewMode(value)}
            options={[
              {
                value: "edit",
                label: t("fileTabs.markdownModeEdit"),
              },
              {
                value: "preview",
                label: t("fileTabs.markdownModePreview"),
              },
            ]}
          />
        ) : null}
      </div>
      {error ? (
        <div className="h-full flex items-center justify-center px-6">
          <Empty description={error} />
        </div>
      ) : markdownFile && markdownViewMode === "preview" ? (
        <div
          ref={previewContainerRef}
          className="app-markdown-preview-shell flex-1 min-h-0 overflow-auto p-5"
          onScroll={handlePreviewScroll}
        >
          <MarkdownPreview
            content={content}
            emptyText={t("fileTabs.markdownPreviewEmpty")}
            filePath={path}
            projectPath={projectPath}
            className="app-markdown-preview-surface"
            onEditBlock={readOnly ? undefined : (block, source) => {
              handleEditorChange(replaceMarkdownSourceBlock(content, block, source));
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
            onOpenExternalLink={(href) => {
              void handleOpenExternalLink(href);
            }}
            onOpenProjectPath={handleOpenProjectMarkdownPath}
          />
        </div>
      ) : (
        <MonacoTextEditor
          filePath={path}
          value={content}
          readOnly={readOnly}
          revealTarget={revealTarget}
          onChange={handleEditorChange}
          onSave={() => {
            void handleSave();
          }}
          saveEnabled={isDirty && !readOnly}
          onScroll={(ratio) => {
            editorScrollTopRef.current = ratio;
          }}
        />
      )}
    </div>
  );
}

export default FileTabView;
