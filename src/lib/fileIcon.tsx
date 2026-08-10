import type { ReactNode } from "react";
import {
  FolderOpenOutlined,
  FolderOutlined,
} from "@ant-design/icons";
import { themeIcons } from "seti-file-icons";

const resolveSetiIcon = themeIcons({
  blue: "#4f8fb3",
  grey: "#64748b",
  "grey-light": "#8391a5",
  green: "#70a83b",
  orange: "#c87532",
  pink: "#d65b86",
  purple: "#8b6bb1",
  red: "#c65353",
  white: "#64748b",
  yellow: "#b79a2f",
  ignore: "#94a3b8",
});

const folderColor = "#5b7cfa";
const markdownIconSvg = `
  <svg viewBox="0 0 32 32" focusable="false">
    <path d="M2.5 8h4l4 5.1 4-5.1h4v16h-4V14l-4 5-4-5v10h-4V8zm20.5 0h4v9h3.5L25 24l-5.5-7H23V8z"/>
  </svg>
`;
const jspIconSvg = `
  <svg viewBox="0 0 32 32" focusable="false">
    <path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M6 3h14l6 6v20H6V3zm14 0v7h6"/>
    <text x="8" y="23" fill="currentColor" font-family="Arial, sans-serif" font-size="8" font-weight="700">JSP</text>
  </svg>
`;
const xmlIconSvg = `
  <svg viewBox="0 0 32 32" focusable="false">
    <path d="M6 3h14l6 6v20H6V3zm2 2v22h16V11h-6V5H8zm12 1.4V9h2.6L20 6.4z"/>
    <path d="m13 15.2-4 3.3 4 3.3v-2.4l-1.2-.9 1.2-.9v-2.4zm6 0v2.4l1.2.9-1.2.9v2.4l4-3.3-4-3.3zm-2.7-.5-2.4 7.6h1.8l2.4-7.6h-1.8z"/>
  </svg>
`;

export interface FileIconInfo {
  icon: ReactNode;
  color: string;
}

export function getFileExtension(name: string): string {
  const normalizedName = name.trim().toLowerCase();
  const lastDotIndex = normalizedName.lastIndexOf(".");
  if (lastDotIndex <= 0 || lastDotIndex === normalizedName.length - 1) return "";
  return normalizedName.slice(lastDotIndex + 1);
}

export function getFileIconByName(fileName: string): FileIconInfo {
  const normalizedName = fileName.trim().toLowerCase();
  const extension = getFileExtension(normalizedName);
  if (extension === "jsp") {
    return {
      icon: (
        <span
          className="app-seti-file-icon app-jsp-file-icon"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: jspIconSvg }}
        />
      ),
      color: "#c65353",
    };
  }
  if (extension === "xml") {
    return {
      icon: (
        <span
          className="app-seti-file-icon app-xml-file-icon"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: xmlIconSvg }}
        />
      ),
      color: "#c87532",
    };
  }
  if (extension === "md" || extension === "mdx" || extension === "markdown") {
    return {
      icon: (
        <span
          className="app-seti-file-icon app-markdown-file-icon"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: markdownIconSvg }}
        />
      ),
      color: "#4f9f5f",
    };
  }
  const visual = resolveSetiIcon(normalizedName);
  return {
    icon: (
      <span
        className="app-seti-file-icon"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: visual.svg }}
      />
    ),
    color: visual.color,
  };
}

export function getFileIcon(fileName: string, isDir = false, isExpanded = false): FileIconInfo {
  if (!isDir) return getFileIconByName(fileName);
  return {
    icon: isExpanded ? <FolderOpenOutlined /> : <FolderOutlined />,
    color: folderColor,
  };
}
