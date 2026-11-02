import { useEffect, useMemo, useRef, useState } from "react";
import { CheckOutlined, CopyOutlined, FullscreenExitOutlined, FullscreenOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import mermaid from "mermaid";

// 每次渲染都使用新 ID，避免不同分块、分屏或异步重绘操作彼此的 SVG。
let mermaidIdCounter = 0;

export function MermaidBlock({ code }: { code: string }) {
  const { t } = useTranslation();
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // React 按对象引用更新 innerHTML，保持引用也能避免复制/全屏操作重建 SVG 节点。
  const svgMarkup = useMemo(() => ({ __html: svg }), [svg]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const diagramRef = useRef<HTMLDivElement | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const syncFullscreenState = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);

  useEffect(() => {
    const svgElement = diagramRef.current?.querySelector("svg");
    if (!svgElement) return;
    svgElement.style.width = isFullscreen ? "92vw" : "";
    svgElement.style.height = "auto";
    svgElement.style.maxWidth = isFullscreen ? "92vw" : "";
    svgElement.style.maxHeight = isFullscreen ? "88vh" : "";
  }, [isFullscreen, svg]);

  useEffect(() => {
    const theme = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "default";
    mermaid.initialize({ startOnLoad: false, theme });
    const id = `mermaid-${++mermaidIdCounter}`;
    let cancelled = false;
    // 等待新结果期间保留上次 SVG，避免异步重绘先把图表高度清零。
    void mermaid.render(id, code)
      .then(({ svg: renderedSvg }) => {
        if (cancelled) return;
        setSvg(renderedSvg);
        setError("");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setSvg("");
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  const handleFullscreen = async () => {
    if (document.fullscreenElement === containerRef.current) {
      await document.exitFullscreen();
      return;
    }
    await containerRef.current?.requestFullscreen?.();
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(svg);
      setCopied(true);
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const fullscreenLabel = t(isFullscreen ? "fileTabs.mermaidExitFullscreen" : "fileTabs.mermaidFullscreen");

  return (
    <div
      ref={containerRef}
      className={`app-markdown-mermaid${error ? " is-error" : ""}${isFullscreen ? " is-fullscreen" : ""}`}
      aria-busy={!svg && !error}
    >
      {error ? (
        <div className="app-markdown-mermaid-error">
          <div className="mb-2 text-[var(--cs-error)]">{t("fileTabs.mermaidRenderFailed")}: {error}</div>
          <details>
            <summary className="cursor-pointer text-[var(--cs-text-tertiary)]">{t("fileTabs.mermaidViewSource")}</summary>
            <pre className="mt-2 overflow-x-auto text-xs leading-6"><code>{code}</code></pre>
          </details>
        </div>
      ) : svg ? (
        <>
          <div className="absolute right-2 top-2 z-10 flex items-center gap-1 bg-transparent">
            <button
              type="button"
              className="app-markdown-mermaid-action"
              onClick={() => void handleFullscreen()}
              aria-label={fullscreenLabel}
              title={fullscreenLabel}
            >
              {isFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
            </button>
            <button
              type="button"
              className="app-markdown-mermaid-action"
              onClick={() => void handleCopy()}
              aria-label={t("fileTabs.mermaidCopy")}
              title={t(copied ? "fileTabs.mermaidCopied" : "fileTabs.mermaidCopy")}
            >
              {copied ? <CheckOutlined /> : <CopyOutlined />}
            </button>
          </div>
          <div ref={diagramRef} className="app-markdown-mermaid-diagram" dangerouslySetInnerHTML={svgMarkup} />
        </>
      ) : (
        <pre className="app-markdown-mermaid-placeholder"><code>{code}</code></pre>
      )}
    </div>
  );
}
