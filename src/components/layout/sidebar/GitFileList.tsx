import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button, Dropdown, Tooltip } from "antd";
import type { MenuProps } from "antd";
import {
  CheckOutlined,
  DownOutlined,
  MinusOutlined,
} from "@ant-design/icons";
import type { GitFileStatus, GitStatusType } from "@/types";
import { getFileIconByName } from "@/lib/fileIcon";
import { getVirtualRange } from "@/lib/virtualList";

const FILE_ROW_HEIGHT = 22;
const FILE_ROW_OVERSCAN = 8;
const INITIAL_RENDERED_ROWS = 40;

/** 文件状态徽章配置 */
const STATUS_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  modified: { label: "M", color: "#d97706", bg: "rgba(217,119,6,0.12)" },
  added: { label: "A", color: "var(--cs-success)", bg: "color-mix(in srgb, var(--cs-success) 12%, transparent)" },
  deleted: { label: "D", color: "var(--cs-error)", bg: "color-mix(in srgb, var(--cs-error) 12%, transparent)" },
  untracked: { label: "U", color: "#6b7280", bg: "rgba(107,114,128,0.12)" },
  renamed: { label: "R", color: "#2563eb", bg: "rgba(37,99,235,0.12)" },
  typechange: { label: "T", color: "#0891b2", bg: "rgba(8,145,178,0.12)" },
  conflicted: { label: "C", color: "#9333ea", bg: "rgba(147,51,234,0.12)" },
};

/** 分割 Git 路径为文件名和父路径 */
function splitGitPath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const fileName = parts.pop() ?? normalized;
  return {
    fileName,
    parentPath: parts.join("\\"),
  };
}

function renderDiffStat(value: number | null | undefined, prefix: "+" | "-") {
  if (typeof value !== "number" || value <= 0) {
    return null;
  }

  return `${prefix}${value}`;
}

interface GitFileListProps {
  /** 文件列表 */
  files: GitFileStatus[];
  /** 是否为已暂存文件 */
  staged: boolean;
  /** 分组标题 */
  sectionTitle: string;
  /** 操作按钮提示文本（暂存/取消暂存） */
  actionText: string;
  /** 是否折叠 */
  collapsed: boolean;
  /** 切换折叠状态 */
  onToggleCollapse: () => void;
  /** 当前正在打开差异的文件路径 */
  openingDiffPath: string | null;
  activeDiffKey: string | null;
  /** 查看差异回调 */
  onViewDiff: (
    filePath: string,
    staged: boolean,
    oldFilePath?: string | null,
    hunkActionsAvailable?: boolean,
    preview?: boolean,
    changeKind?: GitStatusType,
  ) => void;
  /** 暂存/取消暂存单个文件 */
  onToggleFile: (file: GitFileStatus) => void;
  /** 暂存/取消暂存所有文件 */
  onToggleAll: () => void;
  /** 丢弃更改回调（仅 unstaged） */
  onDiscard?: (filePath: string) => void;
  /** 构建右键菜单 */
  buildFileMenu: (file: GitFileStatus, staged: boolean) => MenuProps;
  /** 当前 Git 操作不允许常规暂存/取消暂存 */
  actionsDisabled?: boolean;
  /** 额外的操作按钮（如 discard all） */
  extraActions?: ReactNode;
}

/**
 * Git 文件列表组件
 *
 * 复用于显示已暂存和未暂存的文件列表。
 */
export function GitFileList({
  files,
  staged,
  sectionTitle,
  actionText,
  collapsed,
  onToggleCollapse,
  openingDiffPath,
  activeDiffKey,
  onViewDiff,
  onToggleFile,
  onToggleAll,
  buildFileMenu,
  actionsDisabled = false,
  extraActions,
}: GitFileListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [renderedRange, setRenderedRange] = useState({
    start: 0,
    end: Math.min(files.length, INITIAL_RENDERED_ROWS),
  });

  const updateRenderedRange = useCallback(() => {
    const list = listRef.current;
    const scrollContainer = list?.closest<HTMLElement>(".app-project-tree-scroll");
    if (!list || !scrollContainer) {
      setRenderedRange({ start: 0, end: Math.min(files.length, INITIAL_RENDERED_ROWS) });
      return;
    }

    const listRect = list.getBoundingClientRect();
    const scrollRect = scrollContainer.getBoundingClientRect();
    const nextRange = getVirtualRange(
      files.length,
      FILE_ROW_HEIGHT,
      Math.max(0, scrollRect.top - listRect.top),
      Math.max(0, scrollRect.bottom - listRect.top),
      FILE_ROW_OVERSCAN,
    );
    setRenderedRange((current) =>
      current.start === nextRange.start && current.end === nextRange.end ? current : nextRange,
    );
  }, [files.length]);

  useLayoutEffect(() => {
    updateRenderedRange();
  }, [collapsed, updateRenderedRange]);

  useEffect(() => {
    const list = listRef.current;
    const scrollContainer = list?.closest<HTMLElement>(".app-project-tree-scroll");
    if (!list || !scrollContainer || collapsed) return;

    scrollContainer.addEventListener("scroll", updateRenderedRange, { passive: true });
    const resizeObserver = new ResizeObserver(updateRenderedRange);
    resizeObserver.observe(scrollContainer);
    resizeObserver.observe(list);
    return () => {
      scrollContainer.removeEventListener("scroll", updateRenderedRange);
      resizeObserver.disconnect();
    };
  }, [collapsed, updateRenderedRange]);

  if (files.length === 0) {
    return null;
  }

  return (
    <div className="git-file-list">
      {/* 分组标题 */}
      <div className="group flex items-center justify-between px-2" style={{ height: 22 }}>
        <button
          className="flex items-center gap-1.5 text-left text-[13px] font-semibold"
          style={{ color: "var(--cs-text-primary)" }}
          onClick={onToggleCollapse}
        >
          <DownOutlined className={`text-[9px] transition-transform ${collapsed ? "-rotate-90" : ""}`} />
          <span>{sectionTitle}</span>
        </button>
        <div className="flex items-center gap-1">
          <span
            className="inline-flex items-center justify-center rounded-full px-1.5 text-[10px] leading-[16px] font-medium"
            style={{
              color: "var(--cs-text-secondary)",
              background: "color-mix(in srgb, var(--cs-text-secondary) 10%, transparent)",
              minWidth: 18,
            }}
          >
            {files.length}
          </span>
          <div className="hidden group-hover:flex items-center gap-0.5">
            <Tooltip title={actionText} mouseEnterDelay={0.4}>
              <Button
                type="text"
                size="small"
                icon={staged ? <MinusOutlined /> : <CheckOutlined />}
                disabled={actionsDisabled}
                style={{ width: 20, height: 20, padding: 0, color: "var(--cs-text-secondary)" }}
                onClick={onToggleAll}
              />
            </Tooltip>
            {extraActions}
          </div>
        </div>
      </div>

      {/* 文件列表 */}
      {!collapsed && (
        <div
          ref={listRef}
          className="relative"
          style={{ height: files.length * FILE_ROW_HEIGHT }}
        >
          {files.slice(renderedRange.start, renderedRange.end).map((file, visibleIndex) => {
            const badge = STATUS_BADGE[file.statusType] ?? STATUS_BADGE.modified;
            const { fileName, parentPath } = splitGitPath(file.path);
            const fileVisual = getFileIconByName(fileName);
            const addedText = renderDiffStat(file.insertions, "+");
            const removedText = renderDiffStat(file.deletions, "-");
            const fileKey = `${staged ? "staged" : "unstaged"}-${file.path}`;
            const selected = activeDiffKey === fileKey;
            const hunkActionsAvailable =
              file.statusType !== "conflicted" &&
              file.statusType !== "deleted" &&
              file.statusType !== "typechange" &&
              file.statusType !== "untracked";

            return (
            <div
              key={fileKey}
              className="absolute inset-x-0"
              style={{ top: (renderedRange.start + visibleIndex) * FILE_ROW_HEIGHT }}
            >
              <Dropdown trigger={["contextMenu"]} menu={buildFileMenu(file, staged)}>
                <div
                  className="group flex items-center gap-1.5 px-2 cursor-pointer"
                  style={{
                    height: 22,
                    background:
                      openingDiffPath === file.path || selected
                        ? "color-mix(in srgb, var(--cs-bg-hover) 82%, transparent)"
                        : "transparent",
                    borderLeft:
                      openingDiffPath === file.path || selected
                        ? "2px solid var(--cs-marker-color)"
                        : "2px solid transparent",
                  }}
                  onClick={() => {
                    onViewDiff(
                      file.path,
                      staged,
                      file.oldPath,
                      hunkActionsAvailable,
                      true,
                      file.statusType,
                    );
                  }}
                  onDoubleClick={() => {
                    onViewDiff(
                      file.path,
                      staged,
                      file.oldPath,
                      hunkActionsAvailable,
                      false,
                      file.statusType,
                    );
                  }}
                >
                  <span style={{ color: fileVisual.color, fontSize: 14, display: "inline-flex" }}>{fileVisual.icon}</span>
                  <span
                    className="truncate flex-1 min-w-0 text-[13px] leading-[22px]"
                    style={{
                      color: "var(--cs-text-primary)",
                      textDecoration: !staged && file.statusType === "deleted" ? "line-through" : undefined,
                      opacity: !staged && file.statusType === "deleted" ? 0.5 : 1,
                    }}
                  >
                    {file.oldPath ? (
                      <span className="mr-1 text-[11px]" style={{ color: "var(--cs-text-tertiary)" }}>
                        {file.oldPath} →
                      </span>
                    ) : null}
                    {fileName}
                    {parentPath ? (
                      <span className="ml-1.5 text-[11px]" style={{ color: "var(--cs-text-tertiary)" }}>
                        {parentPath}
                      </span>
                    ) : null}
                  </span>
                  <div className="ml-auto flex items-center shrink-0 gap-2">
                    <span className="git-file-diff-stats">
                      {addedText ? <span className="git-file-diff-added">{addedText}</span> : null}
                      {removedText ? <span className="git-file-diff-removed">{removedText}</span> : null}
                    </span>
                    <span className="shrink-0 inline-flex w-4 justify-center text-[12px] font-semibold leading-[22px]" style={{ color: badge.color }}>
                      {badge.label}
                    </span>
                    <div className="git-file-action-slot">
                      <Tooltip title={actionText} mouseEnterDelay={0.4}>
                        <Button
                          type="text"
                          size="small"
                          icon={staged ? <MinusOutlined /> : <CheckOutlined />}
                          disabled={actionsDisabled}
                          style={{ width: 20, height: 20, padding: 0, color: "var(--cs-text-secondary)" }}
                          className="git-file-action-button"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (actionsDisabled) return;
                            onToggleFile(file);
                          }}
                        />
                      </Tooltip>
                    </div>
                  </div>
                </div>
              </Dropdown>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
