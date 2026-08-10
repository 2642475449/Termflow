import { Alert, Button, Empty, Spin, message } from "antd";
import { ExportOutlined, FolderOpenOutlined, PushpinOutlined } from "@ant-design/icons";
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import MarkdownPreview from "@/components/markdown/MarkdownPreview";
import MonacoTextEditor from "@/components/editors/MonacoTextEditor";
import {
  inspectProjectFile,
  openInAssociatedApplication,
  readProjectFile,
  readProjectImage,
  readProjectPdf,
} from "@/lib/api";
import { openAuxiliaryFile } from "@/lib/auxiliaryDock";
import { useAppStore } from "@/store";

const PdfPreview = lazy(() => import("@/components/pdf/PdfPreview"));

interface AuxiliaryFileViewProps {
  projectPath: string;
  path: string;
  preview: boolean;
  onPin: () => void;
}

function isMarkdown(path: string) {
  return /\.(md|markdown)$/i.test(path);
}

export default function AuxiliaryFileView({
  projectPath,
  path,
  preview,
  onPin,
}: AuxiliaryFileViewProps) {
  const { t } = useTranslation();
  const openFileTab = useAppStore((state) => state.openFileTab);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<"text" | "image" | "pdf" | "binary">("text");
  const [content, setContent] = useState("");
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);

  const name = useMemo(
    () => path.split(/[\\/]/).filter(Boolean).pop() ?? path,
    [path],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent("");
    setImageSrc(null);
    setPdfData(null);

    void inspectProjectFile(projectPath, path)
      .then(async (status) => {
        if (cancelled) return;
        setKind(status.kind);
        if (status.kind === "text") {
          const file = await readProjectFile(projectPath, path);
          if (!cancelled) setContent(file.content);
        } else if (status.kind === "image") {
          const image = await readProjectImage(projectPath, path);
          if (!cancelled) setImageSrc(image.dataUrl);
        } else if (status.kind === "pdf") {
          const pdf = await readProjectPdf(projectPath, path);
          if (!cancelled) setPdfData(pdf);
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [path, projectPath]);

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
          onClick={() => openFileTab(path, { preview: false })}
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
          <div className="app-markdown-preview-shell h-full overflow-auto p-5">
            <MarkdownPreview
              content={content}
              emptyText={t("fileTabs.markdownPreviewEmpty")}
              filePath={path}
              projectPath={projectPath}
              className="app-markdown-preview-surface"
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
            readOnly
            onChange={() => undefined}
          />
        )}
      </div>
    </div>
  );
}
