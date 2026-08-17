import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { Empty } from "antd";
import {
  CheckOutlined,
  CloseOutlined,
  CopyOutlined,
  EditOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  RotateLeftOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from "@ant-design/icons";
import { convertFileSrc } from "@tauri-apps/api/core";
import mermaid from "mermaid";
import { readProjectImage } from "@/lib/api";
import {
  getMarkdownSourceBlocks,
  type MarkdownSourceBlock,
} from "@/components/markdown/markdownSourceBlocks";

type TableAlignment = "left" | "center" | "right";
type ListItem = {
  text: string;
  checked: boolean | null;
  ordered: boolean;
};

type ResolvedMarkdownLink = {
  displayUrl: string;
  projectPath?: string;
};

const UNSAFE_RAW_HTML_TAGS = /<(script|style|iframe|object|embed|svg|math|form|input|button|textarea|select|option|link|meta|base)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?(?:script|style|iframe|object|embed|svg|math|form|input|button|textarea|select|option|link|meta|base)\b[^>]*>/gi;

function sanitizeRawHtml(html: string) {
  return html
    .replace(UNSAFE_RAW_HTML_TAGS, "")
    .replace(/\s+(?:on[a-z]+|style)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(?:href|src)\s*=\s*(['"])(?:javascript|vbscript|data:text\/html)[^'"]*\1/gi, "");
}

function getRawHtmlContainerTag(line: string) {
  const match = line.match(/^\s*<([a-z][\w:-]*)\b[^>]*>/i);
  if (!match) return null;

  const tag = match[1].toLowerCase();
  if (/\/>\s*$/.test(line) || /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(tag)) {
    return null;
  }
  return tag;
}

function countRawHtmlTag(html: string, tag: string, closing = false) {
  const pattern = closing
    ? new RegExp(`</${tag}\\s*>`, "gi")
    : new RegExp(`<${tag}\\b[^>]*>`, "gi");
  return Array.from(html.matchAll(pattern)).length;
}

function cleanMarkdownUrl(url: string) {
  return url.trim().replace(/^`+|`+$/g, "");
}

export function isLikelyMarkdownPath(value: string) {
  const candidate = cleanMarkdownUrl(value);
  if (!candidate || /\s/.test(candidate)) return false;
  if (candidate === "." || candidate === "..") return true;
  if (/^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith("\\\\")) return true;
  if (/^\.{1,2}[\\/]/.test(candidate)) return true;
  if (candidate.includes("/") || candidate.includes("\\")) return true;
  return /^[^<>:"|?*]+\.[A-Za-z0-9]{1,12}(?:#.+)?$/.test(candidate);
}

function getDirectoryPath(filePath: string) {
  const normalized = filePath.replace(/[\\/]+$/, "");
  const separator = normalized.includes("\\") ? "\\" : "/";
  const parts = normalized.split(/[\\/]/);
  parts.pop();
  return parts.join(separator);
}

function joinMarkdownPath(baseDir: string, relativePath: string) {
  const separator = baseDir.includes("\\") ? "\\" : "/";
  const segments = [...baseDir.split(/[\\/]/), ...relativePath.split(/[\\/]/)];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  if (/^[A-Za-z]:$/.test(resolved[0] ?? "")) {
    return `${resolved[0]}${separator}${resolved.slice(1).join(separator)}`;
  }
  return resolved.join(separator);
}

function resolveMarkdownLink(
  url: string,
  filePath?: string,
  projectPath?: string
): ResolvedMarkdownLink {
  const cleaned = cleanMarkdownUrl(url);
  if (!cleaned) return { displayUrl: cleaned };
  if (
    cleaned.startsWith("http://") ||
    cleaned.startsWith("https://") ||
    cleaned.startsWith("data:") ||
    cleaned.startsWith("blob:") ||
    cleaned.startsWith("#") ||
    cleaned.startsWith("mailto:") ||
    cleaned.startsWith("tel:")
  ) {
    return { displayUrl: cleaned };
  }
  if (!filePath && !projectPath) {
    return { displayUrl: cleaned };
  }
  const [pathPart, hashPart] = cleaned.split("#");
  const baseDir = filePath ? getDirectoryPath(filePath) : projectPath!;
  const normalizedPathPart = pathPart.replace(/^[/\\]+/, "");
  const absolutePath =
    /^[A-Za-z]:[\\/]/.test(pathPart) || pathPart.startsWith("\\\\")
      ? pathPart
      : projectPath && (pathPart.startsWith("/") || pathPart.startsWith("\\"))
        ? joinMarkdownPath(projectPath, normalizedPathPart)
        : projectPath && /^public[\\/]/i.test(pathPart)
          ? joinMarkdownPath(projectPath, normalizedPathPart)
          : joinMarkdownPath(baseDir, pathPart);
  try {
    const displayUrl = `${convertFileSrc(absolutePath)}${hashPart ? `#${hashPart}` : ""}`;
    return { displayUrl, projectPath: absolutePath };
  } catch {
    return {
      displayUrl: `${absolutePath}${hashPart ? `#${hashPart}` : ""}`,
      projectPath: absolutePath,
    };
  }
}

function isBadgeImage(src: string, alt?: string): boolean {
  const lowerSrc = src.toLowerCase();
  const lowerAlt = (alt || "").toLowerCase();

  // 检查 URL 是否来自常见的徽章服务
  const badgeDomains = [
    "shields.io",
    "img.shields.io",
    "badge.fury.io",
    "badgen.net",
    "flat.badgen.net",
    "badges.frapsoft.com",
    "badges.gitter.im",
    "ci.appveyor.com/api/badge",
    "travis-ci.org",
    "travis-ci.com",
    "circleci.com",
    "codecov.io",
    "coveralls.io",
    "david-dm.org",
    "snyk.io",
    "opencollective.com",
    "ko-fi.com",
    "buymeacoffee.com",
    "patreon.com",
  ];

  if (badgeDomains.some((domain) => lowerSrc.includes(domain))) {
    return true;
  }

  // 检查 URL 路径是否包含 badge 关键词
  if (lowerSrc.includes("/badge/") || lowerSrc.includes("/badges/") || lowerSrc.includes("badge.")) {
    return true;
  }

  // 检查 alt 文本是否包含徽章相关关键词
  const badgeKeywords = ["badge", "status", "version", "build", "coverage", "license", "npm", "downloads"];
  if (badgeKeywords.some((keyword) => lowerAlt.includes(keyword))) {
    return true;
  }

  // 检查是否是常见的徽章文件名
  if (lowerSrc.includes("shield") || lowerSrc.includes("badge")) {
    return true;
  }

  return false;
}

function ImagePreviewModal({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt?: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const positionStart = useRef({ x: 0, y: 0 });

  const handleZoomIn = useCallback(() => {
    setScale((prev) => Math.min(prev + 0.25, 5));
  }, []);

  const handleZoomOut = useCallback(() => {
    setScale((prev) => Math.max(prev - 0.25, 0.25));
  }, []);

  const handleRotate = useCallback(() => {
    setRotation((prev) => (prev + 90) % 360);
  }, []);

  const handleReset = useCallback(() => {
    setScale(1);
    setRotation(0);
    setPosition({ x: 0, y: 0 });
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setScale((prev) => Math.min(Math.max(prev + delta, 0.25), 5));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY };
    positionStart.current = { ...position };
  }, [position]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setPosition({
      x: positionStart.current.x + dx,
      y: positionStart.current.y + dy,
    });
  }, [isDragging]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "+" || e.key === "=") {
        handleZoomIn();
      } else if (e.key === "-") {
        handleZoomOut();
      } else if (e.key === "r" || e.key === "R") {
        handleRotate();
      } else if (e.key === "0") {
        handleReset();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, handleZoomIn, handleZoomOut, handleRotate, handleReset]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{
        background: "rgba(0, 0, 0, 0.85)",
        backdropFilter: "blur(8px)",
      }}
      onClick={onClose}
    >
      {/* 工具栏 */}
      <div
        className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-2 rounded-lg z-10"
        style={{
          background: "rgba(0, 0, 0, 0.7)",
          border: "1px solid rgba(255, 255, 255, 0.1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="flex items-center justify-center w-8 h-8 rounded hover:bg-white/10 transition-colors"
          style={{ color: "rgba(255, 255, 255, 0.8)" }}
          onClick={handleZoomIn}
          title="放大 (+)"
        >
          <ZoomInOutlined />
        </button>
        <button
          type="button"
          className="flex items-center justify-center w-8 h-8 rounded hover:bg-white/10 transition-colors"
          style={{ color: "rgba(255, 255, 255, 0.8)" }}
          onClick={handleZoomOut}
          title="缩小 (-)"
        >
          <ZoomOutOutlined />
        </button>
        <button
          type="button"
          className="flex items-center justify-center w-8 h-8 rounded hover:bg-white/10 transition-colors"
          style={{ color: "rgba(255, 255, 255, 0.8)" }}
          onClick={handleRotate}
          title="旋转 (R)"
        >
          <RotateLeftOutlined />
        </button>
        <button
          type="button"
          className="flex items-center justify-center w-8 h-8 rounded hover:bg-white/10 transition-colors"
          style={{ color: "rgba(255, 255, 255, 0.8)" }}
          onClick={handleReset}
          title="重置 (0)"
        >
          <span className="text-xs font-medium">1:1</span>
        </button>
        <div className="w-px h-5 bg-white/20 mx-1" />
        <span className="text-xs text-white/60 min-w-[50px] text-center">
          {Math.round(scale * 100)}%
        </span>
      </div>

      {/* 关闭按钮 */}
      <button
        type="button"
        className="absolute top-4 right-4 flex items-center justify-center w-10 h-10 rounded-full z-10 hover:bg-white/10 transition-colors"
        style={{ color: "rgba(255, 255, 255, 0.8)" }}
        onClick={onClose}
        title="关闭 (Esc)"
      >
        <CloseOutlined style={{ fontSize: 18 }} />
      </button>

      {/* 图片容器 */}
      <div
        className="relative w-full h-full flex items-center justify-center overflow-hidden cursor-grab active:cursor-grabbing"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      >
        <img
          src={src}
          alt={alt}
          className="max-w-[90vw] max-h-[90vh] object-contain select-none"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale}) rotate(${rotation}deg)`,
            transition: isDragging ? "none" : "transform 0.2s ease",
          }}
          draggable={false}
        />
      </div>

      {/* 图片信息 */}
      {alt && (
        <div
          className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg z-10 max-w-[80vw]"
          style={{
            background: "rgba(0, 0, 0, 0.7)",
            border: "1px solid rgba(255, 255, 255, 0.1)",
          }}
        >
          <p className="text-sm text-white/70 m-0 truncate">{alt}</p>
        </div>
      )}
    </div>
  );
}

function ImageWithFallback({
  src,
  localPath,
  projectPath,
  alt,
  className,
  style,
  enablePreview = false,
}: {
  src: string;
  localPath?: string;
  projectPath?: string;
  alt?: string;
  className?: string;
  style?: CSSProperties;
  enablePreview?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [displaySrc, setDisplaySrc] = useState(src);
  const isBadge = useMemo(() => isBadgeImage(displaySrc || src, alt), [alt, displaySrc, src]);

  useEffect(() => {
    let disposed = false;
    setFailed(false);
    setShowPreview(false);

    if (!localPath || !projectPath) {
      setDisplaySrc(src);
      return () => {
        disposed = true;
      };
    }

    setDisplaySrc("");
    void readProjectImage(projectPath, localPath)
      .then((result) => {
        if (!disposed) setDisplaySrc(result.dataUrl);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });

    return () => {
      disposed = true;
    };
  }, [localPath, projectPath, src]);

  const handleClick = useCallback((e: MouseEvent) => {
    if (enablePreview && !failed) {
      e.preventDefault();
      e.stopPropagation();
      setShowPreview(true);
    }
  }, [enablePreview, failed]);

  if (failed) {
    return (
      <span
        className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs ${className ?? ""}`}
        style={{
          border: "1px solid var(--cs-border-card)",
          background: "var(--cs-bg-hover)",
          color: "var(--cs-text-secondary)",
          ...style,
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
        {alt || "图片加载失败"}
      </span>
    );
  }

  if (!displaySrc) {
    return (
      <span
        className={`inline-block h-6 w-6 animate-pulse rounded bg-[var(--cs-bg-hover)] ${className ?? ""}`}
        aria-label={alt || "图片加载中"}
      />
    );
  }

  // 徽章图样式：更小、无边框、行内显示
  const badgeClassName = "inline-block align-middle h-5 max-w-none border-0 rounded-none shadow-none";
  // 普通图片样式
  const normalClassName = "inline-block max-h-64 max-w-full align-middle rounded-md border border-[var(--cs-border-card)]";

  return (
    <>
      <img
        src={displaySrc}
        alt={alt}
        className={`${isBadge ? badgeClassName : normalClassName} ${enablePreview && !isBadge ? "cursor-pointer hover:opacity-90 transition-opacity" : ""}`}
        style={style}
        onError={() => setFailed(true)}
        onClick={isBadge ? undefined : handleClick}
      />
      {showPreview && !isBadge && (
          <ImagePreviewModal
          src={displaySrc}
          alt={alt}
          onClose={() => setShowPreview(false)}
        />
      )}
    </>
  );
}

function transformRawHtml(html: string, filePath?: string, projectPath?: string) {
  // 处理 img 标签：移除 alt 属性并添加样式类
  let result = html.replace(/<img\s([^>]*?)\/?>/gi, (_match, attrs) => {
    // 移除 alt 属性
    const cleanedAttrs = attrs.replace(/\s+alt\s*=\s*(['"])[^'"]*\1/gi, "");
    // 检查是否是徽章图
    const srcMatch = attrs.match(/src\s*=\s*(['"])([^'"]*)\1/i);
    const src = srcMatch ? srcMatch[2] : "";
    const isBadge = isBadgeImage(src);
    const badgeClass = isBadge ? "app-html-badge-image" : "";
    return `<img ${cleanedAttrs} class="${badgeClass}" />`;
  });

  // 处理 src/href 属性
  result = result.replace(/(src|href)\s*=\s*(['"])(.*?)\2/gi, (_match, attr, quote, value) => {
    const nextValue = resolveMarkdownLink(value, filePath, projectPath);
    if (attr.toLowerCase() === "href" && nextValue.projectPath) {
      return `${attr}=${quote}${nextValue.displayUrl}${quote} data-markdown-project-path=${quote}${nextValue.projectPath}${quote}`;
    }
    return `${attr}=${quote}${nextValue.displayUrl}${quote}`;
  });

  return result;
}

function RawHtmlBlock({
  html,
  filePath,
  projectPath,
}: {
  html: string;
  filePath?: string;
  projectPath?: string;
}) {
  const sanitizedHtml = useMemo(() => sanitizeRawHtml(html), [html]);
  const transformedHtml = useMemo(
    () => transformRawHtml(sanitizedHtml, filePath, projectPath),
    [filePath, projectPath, sanitizedHtml],
  );
  const [renderedHtml, setRenderedHtml] = useState(transformedHtml);

  useEffect(() => {
    let disposed = false;
    setRenderedHtml(transformedHtml);
    if (!projectPath) return () => {
      disposed = true;
    };

    const localImages = Array.from(sanitizedHtml.matchAll(/src\s*=\s*(['"])(.*?)\1/gi))
      .map((match) => resolveMarkdownLink(match[2], filePath, projectPath))
      .filter((resolved): resolved is Required<ResolvedMarkdownLink> => Boolean(resolved.projectPath));

    if (localImages.length === 0) return () => {
      disposed = true;
    };

    void Promise.all(
      localImages.map(async (resolved) => {
        try {
          const image = await readProjectImage(projectPath, resolved.projectPath);
          return [resolved.displayUrl, image.dataUrl] as const;
        } catch {
          return null;
        }
      }),
    ).then((replacements) => {
      if (disposed) return;
      let nextHtml = transformedHtml;
      for (const replacement of replacements) {
        if (!replacement) continue;
        nextHtml = nextHtml.split(replacement[0]).join(replacement[1]);
      }
      setRenderedHtml(nextHtml);
    });

    return () => {
      disposed = true;
    };
  }, [filePath, projectPath, sanitizedHtml, transformedHtml]);

  return <div className="overflow-auto" dangerouslySetInnerHTML={{ __html: renderedHtml }} />;
}

export function renderInlineMarkdown(
  text: string,
  options: {
    filePath?: string;
    projectPath?: string;
    getFootnoteIndex?: (id: string) => number;
    keyPrefix: string;
    enableImagePreview?: boolean;
  }
) {
  const tokenPattern =
    /(!\[[^\]]*?\]\([^)\n]+?\)|\[[^\]]+?\]\([^)\n]+?\)|\[\^[^\]]+\]|`[^`]+`|\*\*\*[^*\n]+?\*\*\*|___[^_\n]+?___|\*\*[^*\n]+?\*\*|__[^_\n]+?__|~~[^~]+~~|\*(?!\s)[^*\n]+?\*|_(?!\s)[^_\n]+?_|https?:\/\/[^\s<]+|www\.[^\s<]+)/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let matchIndex = 0;

  const pushPlainText = (value: string) => {
    if (!value) return;
    nodes.push(<span key={`${options.keyPrefix}-text-${matchIndex++}`}>{value}</span>);
  };

  for (const match of text.matchAll(tokenPattern)) {
    const token = match[0];
    const start = match.index ?? 0;
    pushPlainText(text.slice(lastIndex, start));

    if (token.startsWith("`") && token.endsWith("`")) {
      const codeValue = token.slice(1, -1);
      const resolved = isLikelyMarkdownPath(codeValue)
        ? resolveMarkdownLink(codeValue, options.filePath, options.projectPath)
        : null;
      const codeNode = (
        <code
          className="rounded px-1.5 py-0.5"
          style={{
            background: "var(--cs-bg-hover)",
            color: "var(--cs-primary)",
            border: "1px solid var(--cs-border-card)",
          }}
        >
          {codeValue}
        </code>
      );

      if (resolved?.projectPath) {
        nodes.push(
          <a
            key={`${options.keyPrefix}-code-path-${matchIndex++}`}
            href={resolved.displayUrl}
            data-markdown-project-path={resolved.projectPath}
            className="inline-block cursor-pointer transition-opacity hover:opacity-80"
            title={resolved.projectPath}
          >
            {codeNode}
          </a>
        );
      } else {
        nodes.push(
          <span key={`${options.keyPrefix}-code-${matchIndex++}`}>{codeNode}</span>
        );
      }
    } else if (token.startsWith("![") && token.includes("](")) {
      const imageMatch = token.match(/^!\[(.*?)\]\((.*?)\)$/);
      if (imageMatch) {
        const resolved = resolveMarkdownLink(imageMatch[2], options.filePath, options.projectPath);
        nodes.push(
          <ImageWithFallback
            key={`${options.keyPrefix}-img-${matchIndex++}`}
            src={resolved.displayUrl}
            localPath={resolved.projectPath}
            projectPath={options.projectPath}
            alt={imageMatch[1]}
            enablePreview={options.enableImagePreview}
          />
        );
      } else {
        pushPlainText(token);
      }
    } else if (token.startsWith("[") && token.includes("](")) {
      const linkMatch = token.match(/^\[(.*?)\]\((.*?)\)$/);
      if (linkMatch) {
        const resolved = resolveMarkdownLink(linkMatch[2], options.filePath, options.projectPath);
        nodes.push(
          <a
            key={`${options.keyPrefix}-link-${matchIndex++}`}
            href={resolved.displayUrl}
            data-markdown-project-path={resolved.projectPath}
            className="underline decoration-[var(--cs-border-card)] underline-offset-4 transition-colors hover:text-[var(--cs-primary)]"
            style={{ color: "var(--cs-primary)" }}
          >
            {linkMatch[1]}
          </a>
        );
      } else {
        pushPlainText(token);
      }
    } else if (token.startsWith("[^") && token.endsWith("]")) {
      const footnoteId = token.slice(2, -1);
      const footnoteIndex = options.getFootnoteIndex?.(footnoteId) ?? 0;
      nodes.push(
        <sup key={`${options.keyPrefix}-footnote-${matchIndex++}`} className="align-super text-[11px]">
          <a
            href={`#markdown-footnote-${footnoteId}`}
            className="transition-colors hover:text-[var(--cs-primary)]"
            style={{ color: "var(--cs-primary)" }}
          >
            [{footnoteIndex}]
          </a>
        </sup>
      );
    } else if (
      (token.startsWith("***") && token.endsWith("***")) ||
      (token.startsWith("___") && token.endsWith("___"))
    ) {
      nodes.push(
        <strong key={`${options.keyPrefix}-strong-em-${matchIndex++}`}>
          <em>{token.slice(3, -3)}</em>
        </strong>
      );
    } else if (
      (token.startsWith("**") && token.endsWith("**")) ||
      (token.startsWith("__") && token.endsWith("__"))
    ) {
      nodes.push(
        <strong key={`${options.keyPrefix}-strong-${matchIndex++}`}>
          {renderInlineMarkdown(token.slice(2, -2), {
            ...options,
            keyPrefix: `${options.keyPrefix}-strong-${matchIndex}`,
          })}
        </strong>
      );
    } else if (token.startsWith("~~") && token.endsWith("~~")) {
      nodes.push(
        <del key={`${options.keyPrefix}-del-${matchIndex++}`} style={{ color: "var(--cs-text-tertiary)" }}>
          {token.slice(2, -2)}
        </del>
      );
    } else if (
      (token.startsWith("*") && token.endsWith("*")) ||
      (token.startsWith("_") && token.endsWith("_"))
    ) {
      nodes.push(
        <em key={`${options.keyPrefix}-em-${matchIndex++}`}>{token.slice(1, -1)}</em>
      );
    } else {
      const resolved = resolveMarkdownLink(
        token.startsWith("www.") ? `https://${token}` : token,
        options.filePath,
        options.projectPath
      );
      nodes.push(
        <a
          key={`${options.keyPrefix}-auto-${matchIndex++}`}
          href={resolved.displayUrl}
          data-markdown-project-path={resolved.projectPath}
          className="underline decoration-[var(--cs-border-card)] underline-offset-4 transition-colors hover:text-[var(--cs-primary)]"
          style={{ color: "var(--cs-primary)" }}
        >
          {token}
        </a>
      );
    }

    lastIndex = start + token.length;
  }

  pushPlainText(text.slice(lastIndex));
  return nodes.length > 0 ? nodes : <span>{text}</span>;
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }, [code]);

  return (
    <div
      className="group overflow-hidden rounded-xl"
      style={{
        border: "1px solid var(--cs-border-card)",
        background: "var(--cs-bg-hover)",
      }}
    >
      <div
        className="flex items-center justify-between gap-3 px-3 py-2 text-[11px]"
        style={{
          color: "var(--cs-text-tertiary)",
          borderBottom: "1px solid var(--cs-border-card)",
        }}
      >
        <span className="uppercase tracking-wide">{language || "code"}</span>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded px-2 py-1 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
          style={{ color: copied ? "var(--cs-primary)" : "var(--cs-text-tertiary)" }}
          onClick={() => void handleCopy()}
          aria-label={copied ? "已复制" : "复制代码"}
          title={copied ? "已复制" : "复制代码"}
        >
          {copied ? <CheckOutlined /> : <CopyOutlined />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      <pre
        className="m-0 overflow-x-auto p-4 text-xs leading-6"
        style={{ color: "var(--cs-text-secondary)" }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

function parseTableRow(line: string) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string) {
  // 与常见 Markdown 编辑器保持兼容：除了标准的 `---`，也接受
  // `--` 形式的紧凑分隔行，避免将整张表格降级为普通段落。
  return /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/.test(line);
}

function parseTableAlignment(line: string): TableAlignment[] {
  return parseTableRow(line).map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    return "left";
  });
}

export interface MarkdownPreviewProps {
  content: string;
  emptyText: string;
  className?: string;
  filePath?: string;
  projectPath?: string;
  enableImagePreview?: boolean;
  onOpenExternalLink?: (href: string) => void;
  onOpenProjectPath?: (path: string) => void;
  onEditBlock?: (block: MarkdownSourceBlock, source: string) => void;
  editBlockLabel?: string;
  finishEditingLabel?: string;
  cancelEditingLabel?: string;
}

function MarkdownPreviewRenderer({
  content,
  emptyText,
  className,
  filePath,
  projectPath,
  enableImagePreview = true,
  onOpenExternalLink,
  onOpenProjectPath,
}: MarkdownPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { lines, footnotes } = useMemo(() => {
    const normalizedLines = content.replace(/\r\n/g, "\n").split("\n");
    const remainingLines: string[] = [];
    const parsedFootnotes = new Map<string, string>();
    for (let index = 0; index < normalizedLines.length; index += 1) {
      const line = normalizedLines[index];
      const match = line.match(/^\[\^([^\]]+)\]:\s+(.*)$/);
      if (!match) {
        remainingLines.push(line);
        continue;
      }
      const id = match[1];
      const chunks = [match[2]];
      while (index + 1 < normalizedLines.length) {
        const nextLine = normalizedLines[index + 1];
        if (/^\s{2,}\S/.test(nextLine)) {
          index += 1;
          chunks.push(nextLine.trim());
          continue;
        }
        break;
      }
      parsedFootnotes.set(id, chunks.join(" "));
    }
    return { lines: remainingLines, footnotes: parsedFootnotes };
  }, [content]);

  const isReadmeDocument = useMemo(() => {
    const fileName = filePath?.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() ?? "";
    return fileName === "readme.md" || fileName === "readme.markdown";
  }, [filePath]);
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: ListItem[] = [];
  let quoteLines: string[] = [];
  let codeLines: string[] = [];
  let codeFenceLanguage = "";
  let inCodeBlock = false;
  const footnoteOrder: string[] = [];

  const getFootnoteIndex = (id: string) => {
    const existingIndex = footnoteOrder.indexOf(id);
    if (existingIndex >= 0) return existingIndex + 1;
    footnoteOrder.push(id);
    return footnoteOrder.length;
  };

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(
      <p
        key={`p-${blocks.length}`}
        className="m-0 text-sm leading-6"
        style={{ color: "var(--cs-text-secondary)" }}
      >
        {renderInlineMarkdown(paragraph.join(" "), {
          filePath,
          projectPath,
          getFootnoteIndex,
          keyPrefix: `p-${blocks.length}`,
          enableImagePreview,
        })}
      </p>
    );
    paragraph = [];
  };

  const flushList = () => {
    if (listItems.length === 0) return;
    const ordered = listItems[0]?.ordered ?? false;
    const ListTag = ordered ? "ol" : "ul";
    blocks.push(
      <ListTag
        key={`ul-${blocks.length}`}
        className="m-0 pl-5 space-y-1 text-sm leading-6"
        style={{ color: "var(--cs-text-secondary)" }}
      >
        {listItems.map((item, index) => (
          <li key={`${item.text}-${index}`} className="leading-6">
            {item.checked === null ? null : (
              <input
                type="checkbox"
                checked={item.checked}
                readOnly
                className="mr-2 align-middle accent-[var(--cs-primary)]"
              />
            )}
            {renderInlineMarkdown(item.text, {
              filePath,
              projectPath,
              getFootnoteIndex,
              keyPrefix: `li-${blocks.length}-${index}`,
              enableImagePreview,
            })}
          </li>
        ))}
      </ListTag>
    );
    listItems = [];
  };

  const flushQuote = () => {
    if (quoteLines.length === 0) return;
    blocks.push(
      <div
        key={`quote-${blocks.length}`}
        className="rounded-r-xl px-4 py-2 text-sm leading-6"
        style={{
          color: "var(--cs-text-secondary)",
          borderLeft: "3px solid var(--cs-primary)",
          background: "var(--cs-bg-hover)",
        }}
      >
        {renderInlineMarkdown(quoteLines.join(" "), {
          filePath,
          projectPath,
          getFootnoteIndex,
          keyPrefix: `quote-${blocks.length}`,
          enableImagePreview,
        })}
      </div>
    );
    quoteLines = [];
  };

  const mermaidIdCounter = useRef(0);

  function MermaidBlock({ code }: { code: string }) {
    const [svg, setSvg] = useState<string>("");
    const [error, setError] = useState<string>("");
    const [copied, setCopied] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
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
      const id = `mermaid-${++mermaidIdCounter.current}`;
      let cancelled = false;
      mermaid
        .render(id, code)
        .then(({ svg: renderedSvg }) => {
          if (!cancelled) {
            setSvg(renderedSvg);
            setError("");
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
            setSvg("");
          }
        });
      return () => {
        cancelled = true;
      };
    }, [code]);

    if (error) {
      return (
        <div
          className="overflow-hidden rounded-xl"
          style={{
            border: "1px solid var(--cs-error)",
            background: "var(--cs-bg-hover)",
          }}
        >
          <div
            className="px-3 py-2 text-[11px] uppercase tracking-wide"
            style={{
              color: "var(--cs-error)",
              borderBottom: "1px solid var(--cs-error)",
            }}
          >
            mermaid (error)
          </div>
          <div className="p-4 text-xs" style={{ color: "var(--cs-text-secondary)" }}>
            <div style={{ color: "var(--cs-error)", marginBottom: 8 }}>{error}</div>
            <details>
              <summary style={{ cursor: "pointer", color: "var(--cs-text-tertiary)" }}>
                查看源码
              </summary>
              <pre className="mt-2 overflow-x-auto text-xs leading-6" style={{ color: "var(--cs-text-secondary)" }}>
                <code>{code}</code>
              </pre>
            </details>
          </div>
        </div>
      );
    }

    if (!svg) return null;

    const handleFullscreen = async () => {
      if (document.fullscreenElement === containerRef.current) {
        await document.exitFullscreen();
        return;
      }
      if (containerRef.current?.requestFullscreen) {
        await containerRef.current.requestFullscreen();
      }
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

    return (
      <div
        ref={containerRef}
        className="relative overflow-hidden rounded-xl"
        style={{
          border: "1px solid var(--cs-border-card)",
          background: "var(--cs-bg-hover)",
          padding: 16,
          textAlign: "center",
          ...(isFullscreen
            ? {
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }
            : {}),
        }}
      >
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1 bg-transparent">
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded border-0 bg-transparent text-[var(--cs-text-secondary)] transition-colors hover:bg-black/5 hover:text-[var(--cs-primary)] dark:hover:bg-white/10"
            onClick={() => void handleFullscreen()}
            aria-label={isFullscreen ? "退出全屏" : "全屏查看图表"}
            title={isFullscreen ? "缩小图表" : "全屏查看"}
          >
            {isFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
          </button>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded border-0 bg-transparent text-[var(--cs-text-secondary)] transition-colors hover:bg-black/5 hover:text-[var(--cs-primary)] dark:hover:bg-white/10"
            onClick={() => void handleCopy()}
            aria-label="复制图表"
            title={copied ? "已复制" : "复制图表"}
          >
            {copied ? <CheckOutlined /> : <CopyOutlined />}
          </button>
        </div>
        <div ref={diagramRef} dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
    );
  }

  const flushCode = () => {
    if (codeFenceLanguage?.toLowerCase() === "mermaid") {
      blocks.push(
        <MermaidBlock key={`mermaid-${blocks.length}`} code={codeLines.join("\n")} />
      );
      codeLines = [];
      codeFenceLanguage = "";
      return;
    }
    if (codeLines.length === 0 && !codeFenceLanguage) return;
    blocks.push(
      <CodeBlock
        key={`code-${blocks.length}`}
        code={codeLines.join("\n") || ""}
        language={codeFenceLanguage}
      />
    );
    codeLines = [];
    codeFenceLanguage = "";
  };

  const flushHtmlBlock = (htmlLines: string[]) => {
    if (htmlLines.length === 0) return;
    blocks.push(
      <RawHtmlBlock
        key={`html-${blocks.length}`}
        html={htmlLines.join("\n")}
        filePath={filePath}
        projectPath={projectPath}
      />
    );
  };

  const flushTable = (headerLine: string, separatorLine: string, bodyLines: string[]) => {
    const headers = parseTableRow(headerLine);
    const alignments = parseTableAlignment(separatorLine);
    const rows = bodyLines.map(parseTableRow);
    const alignStyles = (alignment: TableAlignment): CSSProperties => ({
      textAlign: alignment,
    });
    blocks.push(
      <div
        key={`table-${blocks.length}`}
        className="overflow-x-auto rounded-xl"
        style={{ border: "1px solid var(--cs-border-card)" }}
      >
        <table className="w-full border-collapse text-sm">
          <thead style={{ background: "var(--cs-bg-hover)" }}>
            <tr>
              {headers.map((header, index) => (
                <th
                  key={`${header}-${index}`}
                  className="px-3 py-2"
                  style={{
                    ...alignStyles(alignments[index] ?? "left"),
                    color: "var(--cs-text-primary)",
                    borderBottom: "1px solid var(--cs-border-card)",
                  }}
                >
                  {renderInlineMarkdown(header, {
                    filePath,
                    projectPath,
                    getFootnoteIndex,
                    keyPrefix: `th-${blocks.length}-${index}`,
                    enableImagePreview,
                  })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`} style={{ borderTop: "1px solid var(--cs-border-card)" }}>
                {row.map((cell, cellIndex) => (
                  <td
                    key={`cell-${rowIndex}-${cellIndex}`}
                    className="px-3 py-2 align-top"
                    style={{
                      ...alignStyles(alignments[cellIndex] ?? "left"),
                      color: "var(--cs-text-secondary)",
                    }}
                  >
                    {renderInlineMarkdown(cell, {
                      filePath,
                      projectPath,
                      getFootnoteIndex,
                      keyPrefix: `td-${blocks.length}-${rowIndex}-${cellIndex}`,
                      enableImagePreview,
                    })}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (inCodeBlock) {
      if (line.trimStart().startsWith("```")) {
        inCodeBlock = false;
        flushCode();
      } else {
        codeLines.push(line);
      }
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      flushList();
      flushQuote();
      blocks.push(<hr key={`hr-${blocks.length}`} />);
      continue;
    }

    const tableSeparator = lines[index + 1];
    if (tableSeparator && line.includes("|") && isTableSeparator(tableSeparator)) {
      flushParagraph();
      flushList();
      flushQuote();
      const bodyLines: string[] = [];
      index += 2;
      while (index < lines.length) {
        const nextLine = lines[index];
        if (!nextLine.trim() || !nextLine.includes("|")) {
          index -= 1;
          break;
        }
        bodyLines.push(nextLine);
        index += 1;
      }
      flushTable(line, tableSeparator, bodyLines);
      continue;
    }

    if (trimmed.startsWith("<")) {
      flushParagraph();
      flushList();
      flushQuote();
      const htmlLines = [line];
      const containerTag = getRawHtmlContainerTag(line);

      if (containerTag) {
        let depth = countRawHtmlTag(line, containerTag) - countRawHtmlTag(line, containerTag, true);
        while (depth > 0 && index + 1 < lines.length) {
          const nextLine = lines[index + 1];
          if (!nextLine.trim()) break;
          index += 1;
          htmlLines.push(nextLine);
          depth += countRawHtmlTag(nextLine, containerTag) - countRawHtmlTag(nextLine, containerTag, true);
        }
      } else {
        while (index + 1 < lines.length) {
          const nextLine = lines[index + 1];
          if (!nextLine.trim()) break;
          if (nextLine.trimStart().startsWith("<") || nextLine.includes("<img")) {
            index += 1;
            htmlLines.push(nextLine);
            continue;
          }
          break;
        }
      }
      flushHtmlBlock(htmlLines);
      continue;
    }

    const headingMatch = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      const level = Math.min(headingMatch[1].length, 6);
      const HeadingTag = `h${level}` as keyof React.JSX.IntrinsicElements;
      const headingText = headingMatch[2];
      // 生成锚点 ID（将标题文本转换为 URL 友好的格式）
      const headingId = headingText
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .trim();
      blocks.push(
        <HeadingTag
          key={`heading-${blocks.length}`}
          id={`heading-${headingId}`}
          className={level <= 2 ? "m-0 text-lg font-semibold" : "m-0 text-base font-semibold"}
          style={{ color: "var(--cs-text-primary)" }}
        >
          {renderInlineMarkdown(headingText, {
            filePath,
            projectPath,
            getFootnoteIndex,
            keyPrefix: `heading-${blocks.length}`,
            enableImagePreview,
          })}
        </HeadingTag>
      );
      continue;
    }

    const fenceMatch = line.match(/^\s*```(.*)$/);
    if (fenceMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      inCodeBlock = true;
      codeFenceLanguage = fenceMatch[1].trim();
      continue;
    }

    const taskListMatch = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (taskListMatch) {
      flushParagraph();
      flushQuote();
      listItems.push({
        text: taskListMatch[2],
        checked: taskListMatch[1].toLowerCase() === "x",
        ordered: false,
      });
      continue;
    }

    const orderedListMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    if (orderedListMatch) {
      flushParagraph();
      flushQuote();
      listItems.push({
        text: orderedListMatch[1],
        checked: null,
        ordered: true,
      });
      continue;
    }

    const listMatch = line.match(/^\s*[-*+]\s+(.*)$/);
    if (listMatch) {
      flushParagraph();
      flushQuote();
      listItems.push({
        text: listMatch[1],
        checked: null,
        ordered: false,
      });
      continue;
    }

    const quoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quoteLines.push(quoteMatch[1]);
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  flushQuote();
  if (inCodeBlock || codeLines.length > 0 || codeFenceLanguage) {
    flushCode();
  }

  if (footnoteOrder.length > 0) {
    blocks.push(
      <div
        key={`footnotes-${blocks.length}`}
        className="space-y-3 pt-4"
        style={{ borderTop: "1px solid var(--cs-border-card)" }}
      >
        <div className="text-xs uppercase tracking-wide text-[var(--cs-text-tertiary)]">
          Footnotes
        </div>
        <ol className="m-0 pl-5 space-y-2 text-sm">
          {footnoteOrder.map((id, index) => (
            <li key={id} id={`markdown-footnote-${id}`} style={{ color: "var(--cs-text-secondary)" }}>
              {renderInlineMarkdown(footnotes.get(id) ?? "", {
                filePath,
                projectPath,
                getFootnoteIndex,
                keyPrefix: `footnote-${index}`,
                enableImagePreview,
              })}
            </li>
          ))}
        </ol>
      </div>
    );
  }

  const handleClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement | null)?.closest("a");
    if (!anchor) return;
    const rawHref = anchor.getAttribute("href") ?? "";
    if (!rawHref) return;
    if (rawHref.startsWith("#")) {
      event.preventDefault();
      const target = containerRef.current?.querySelector(rawHref);
      if (target instanceof HTMLElement) {
        // 平滑滚动到目标位置
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        // 添加高亮效果
        target.style.transition = "background-color 0.3s ease";
        target.style.backgroundColor = "color-mix(in srgb, var(--cs-primary) 15%, transparent)";
        setTimeout(() => {
          target.style.backgroundColor = "";
        }, 1500);
      }
      return;
    }
    const projectPath = anchor.getAttribute("data-markdown-project-path");
    if (projectPath) {
      event.preventDefault();
      onOpenProjectPath?.(projectPath);
      return;
    }
    event.preventDefault();
    onOpenExternalLink?.(rawHref);
  };

  if (blocks.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={emptyText}
        style={{ padding: "48px 0" }}
      />
    );
  }

  const previewClassName = [
    "app-markdown-preview",
    isReadmeDocument ? "app-markdown-preview-readme" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article
      ref={containerRef}
      className={previewClassName}
      onClickCapture={handleClickCapture}
    >
      {blocks}
    </article>
  );
}

interface EditableMarkdownBlockProps {
  block: MarkdownSourceBlock;
  active: boolean;
  draft: string;
  previewProps: MarkdownPreviewProps;
  onBegin: () => void;
  onDraftChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function EditableMarkdownBlock({
  block,
  active,
  draft,
  previewProps,
  onBegin,
  onDraftChange,
  onCommit,
  onCancel,
}: EditableMarkdownBlockProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!active || !textareaRef.current) return;
    const textarea = textareaRef.current;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.max(96, textarea.scrollHeight)}px`;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [active]);

  useEffect(() => {
    if (!active || !textareaRef.current) return;
    const textarea = textareaRef.current;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.max(96, textarea.scrollHeight)}px`;
  }, [active, draft]);

  if (active) {
    return (
      <div className="app-markdown-editable-block is-editing" data-markdown-block-kind={block.kind}>
        <textarea
          ref={textareaRef}
          className="app-markdown-block-editor"
          value={draft}
          spellCheck={false}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
              return;
            }
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              onCommit();
            }
          }}
        />
        <div className="app-markdown-block-actions is-editing">
          <span className="app-markdown-block-shortcut">Esc</span>
          <button
            type="button"
            className="app-markdown-block-action"
            onClick={onCancel}
            title={previewProps.cancelEditingLabel ?? "Cancel editing"}
            aria-label={previewProps.cancelEditingLabel ?? "Cancel editing"}
          >
            <CloseOutlined />
          </button>
          <span className="app-markdown-block-shortcut">Ctrl+Enter</span>
          <button
            type="button"
            className="app-markdown-block-action is-primary"
            onClick={onCommit}
            title={previewProps.finishEditingLabel ?? "Finish editing"}
            aria-label={previewProps.finishEditingLabel ?? "Finish editing"}
          >
            <CheckOutlined />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="app-markdown-editable-block"
      data-markdown-block-kind={block.kind}
      onDoubleClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("a, button, img, input")) return;
        onBegin();
      }}
    >
      <MarkdownPreviewRenderer
        {...previewProps}
        content={block.source}
        className="app-markdown-block-renderer"
        onEditBlock={undefined}
      />
      <button
        type="button"
        className="app-markdown-block-edit-trigger"
        onClick={onBegin}
        title={previewProps.editBlockLabel ?? "Edit block"}
        aria-label={previewProps.editBlockLabel ?? "Edit block"}
      >
        <EditOutlined />
      </button>
    </div>
  );
}

function EditableMarkdownPreview(props: MarkdownPreviewProps) {
  const { content, onEditBlock } = props;
  const blocks = useMemo(() => {
    if (/^\[\^[^\]]+\]:/m.test(content)) {
      return content
        ? [{ id: `0:${content.length}`, kind: "paragraph" as const, start: 0, end: content.length, source: content }]
        : [];
    }
    return getMarkdownSourceBlocks(content);
  }, [content]);
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!activeBlockId) return;
    const activeBlock = blocks.find((block) => block.id === activeBlockId);
    if (activeBlock) return;
    setActiveBlockId(null);
    setDraft("");
  }, [activeBlockId, blocks]);

  if (blocks.length === 0) {
    return <MarkdownPreviewRenderer {...props} onEditBlock={undefined} />;
  }

  return (
    <article className={`app-markdown-preview app-markdown-editable-preview ${props.className ?? ""}`}>
      {blocks.map((block) => (
        <EditableMarkdownBlock
          key={block.id}
          block={block}
          active={activeBlockId === block.id}
          draft={activeBlockId === block.id ? draft : block.source}
          previewProps={props}
          onBegin={() => {
            setActiveBlockId(block.id);
            setDraft(block.source);
          }}
          onDraftChange={setDraft}
          onCancel={() => {
            setActiveBlockId(null);
            setDraft("");
          }}
          onCommit={() => {
            onEditBlock?.(block, draft);
            setActiveBlockId(null);
            setDraft("");
          }}
        />
      ))}
    </article>
  );
}

export default function MarkdownPreview(props: MarkdownPreviewProps) {
  if (props.onEditBlock) {
    return <EditableMarkdownPreview {...props} />;
  }
  return <MarkdownPreviewRenderer {...props} />;
}
