import { Button, Empty, Spin, message } from "antd";
import { ExportOutlined, FileOutlined, ReloadOutlined } from "@ant-design/icons";
import { FileViewer, type FileViewerHandle, type ViewerOptions } from "@file-viewer/react";
import { wordRenderer } from "@file-viewer/renderer-word";
import { spreadsheetRenderer } from "@file-viewer/renderer-spreadsheet";
import { presentationRenderer } from "@file-viewer/renderer-presentation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openInAssociatedApplication, readProjectOfficePreview } from "@/lib/api";

interface OfficeFilePreviewProps {
  projectPath: string;
  path: string;
}

// 上游渲染器把挂载节点收窄为 HTMLDivElement，而 React 适配器声明为 HTMLElement。
// 两边运行时契约一致；在依赖修正泛型协变前集中处理这处类型差异。
const OFFICE_RENDERERS = [
  wordRenderer,
  spreadsheetRenderer,
  presentationRenderer,
] as unknown as NonNullable<ViewerOptions["renderers"]>;

export default function OfficeFilePreview({ projectPath, path }: OfficeFilePreviewProps) {
  const { i18n, t } = useTranslation();
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<FileViewerHandle | null>(null);
  const lastWheelZoomAtRef = useRef(0);
  const fileName = useMemo(() => path.split(/[\\/]/).filter(Boolean).pop() ?? path, [path]);

  const openExternal = useCallback(async () => {
    try {
      await openInAssociatedApplication(path);
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : String(reason));
    }
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    void readProjectOfficePreview(projectPath, path)
      .then((bytes) => {
        if (!cancelled) setData(bytes.slice().buffer);
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
  }, [path, projectPath, reloadVersion]);

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview || !data) return;

    const handleWheel = (event: WheelEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.deltaY === 0) return;
      event.preventDefault();

      const now = performance.now();
      if (now - lastWheelZoomAtRef.current < 80) return;
      lastWheelZoomAtRef.current = now;

      if (event.deltaY < 0) {
        void viewerRef.current?.zoomIn();
      } else {
        void viewerRef.current?.zoomOut();
      }
    };

    preview.addEventListener("wheel", handleWheel, { passive: false });
    return () => preview.removeEventListener("wheel", handleWheel);
  }, [data]);

  if (loading) {
    return <div className="flex h-full items-center justify-center"><Spin tip={t("fileTabs.loading")} /></div>;
  }

  if (error || !data) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <Empty
          image={<FileOutlined className="text-5xl text-[var(--cs-text-tertiary)]" />}
          description={error ?? t("fileTabs.officePreviewUnavailable")}
        >
          <div className="flex justify-center gap-2">
            <Button icon={<ReloadOutlined />} onClick={() => setReloadVersion((value) => value + 1)}>
              {t("common.retry")}
            </Button>
            <Button icon={<ExportOutlined />} onClick={() => { void openExternal(); }}>
              {t("common.openInAssociatedApp")}
            </Button>
          </div>
        </Empty>
      </div>
    );
  }

  return (
    <div ref={previewRef} className="app-office-file-preview h-full min-h-0">
      <div className="h-full min-h-0">
        <FileViewer
          ref={viewerRef}
          buffer={data}
          filename={fileName}
          options={{
            locale: i18n.resolvedLanguage ?? "auto",
            theme: "system",
            rendererMode: "replace",
            renderers: OFFICE_RENDERERS,
            toolbar: false,
            docx: {
              visualPagination: true,
              strictWordCompatibility: true,
              awaitLayout: true,
              externalLinkPolicy: "block",
              externalResourcePolicy: "block",
            },
            ui: { density: "compact" },
          }}
          className="h-full w-full"
        />
      </div>
    </div>
  );
}
