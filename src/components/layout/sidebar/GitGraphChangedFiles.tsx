import { LoadingOutlined, WarningOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { getFileIconByName } from "@/lib/fileIcon";
import type { GitGraphChangedFile } from "@/types";

export const GIT_GRAPH_FILE_ROW_HEIGHT = 22;

const STATUS_BADGE: Record<string, { label: string; color: string }> = {
  modified: { label: "M", color: "#d97706" },
  added: { label: "A", color: "var(--cs-success)" },
  deleted: { label: "D", color: "var(--cs-error)" },
  renamed: { label: "R", color: "#2563eb" },
  copied: { label: "C", color: "#2563eb" },
  typechange: { label: "T", color: "#0891b2" },
  conflicted: { label: "!", color: "#9333ea" },
  untracked: { label: "U", color: "#6b7280" },
  unreadable: { label: "?", color: "var(--cs-error)" },
};

export interface GitGraphLaneLine {
  x: number;
  color: string;
}

export function getGitGraphExpansionRowCount(
  files: GitGraphChangedFile[],
  loading: boolean,
  error: boolean,
): number {
  return loading || error || files.length === 0 ? 1 : files.length;
}

function splitGitPath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const fileName = parts.pop() ?? normalized;
  return {
    fileName,
    parentPath: parts.join("\\"),
  };
}

interface GitGraphChangedFilesProps {
  files: GitGraphChangedFile[];
  loading: boolean;
  error: boolean;
  graphWidth: number;
  graphInset: number;
  laneLines: GitGraphLaneLine[];
  selectedFileKey: string | null;
  openingFileKey: string | null;
  getFileKey: (file: GitGraphChangedFile) => string;
  onFileSelect: (file: GitGraphChangedFile) => void;
}

export function GitGraphChangedFiles({
  files,
  loading,
  error,
  graphWidth,
  graphInset,
  laneLines,
  selectedFileKey,
  openingFileKey,
  getFileKey,
  onFileSelect,
}: GitGraphChangedFilesProps) {
  const { t } = useTranslation();
  const rowCount = getGitGraphExpansionRowCount(files, loading, error);
  const height = rowCount * GIT_GRAPH_FILE_ROW_HEIGHT;

  const stateRow = loading ? (
    <>
      <LoadingOutlined />
      <span>{t("sidebar.gitGraphFilesLoading")}</span>
    </>
  ) : error ? (
    <>
      <WarningOutlined />
      <span>{t("sidebar.gitGraphFilesLoadFailed")}</span>
    </>
  ) : (
    <span>{t("sidebar.gitGraphFilesEmpty")}</span>
  );

  return (
    <div className="relative" style={{ height }}>
      <svg
        className="absolute top-0"
        style={{ left: graphInset }}
        width={graphWidth}
        height={height}
        viewBox={`0 0 ${graphWidth} ${height}`}
        aria-hidden="true"
      >
        {laneLines.map((line, index) => (
          <path
            key={`${line.x}:${index}`}
            d={`M ${line.x} 0 V ${height}`}
            fill="none"
            stroke={line.color}
            strokeWidth={1}
            strokeLinecap="round"
          />
        ))}
      </svg>

      <div
        style={{
          marginLeft: graphInset + graphWidth + 8,
          marginRight: graphInset,
        }}
      >
        {loading || error || files.length === 0 ? (
          <div
            className="flex items-center gap-1.5 px-1 text-[11px]"
            style={{
              height: GIT_GRAPH_FILE_ROW_HEIGHT,
              color: error ? "var(--cs-error)" : "var(--cs-text-tertiary)",
            }}
          >
            {stateRow}
          </div>
        ) : (
          files.map((file) => {
            const { fileName, parentPath } = splitGitPath(file.path);
            const fileVisual = getFileIconByName(fileName);
            const badge = STATUS_BADGE[file.status] ?? STATUS_BADGE.modified;
            const fileKey = getFileKey(file);
            const selected = selectedFileKey === fileKey;
            const opening = openingFileKey === fileKey;

            return (
              <button
                key={`${file.status}:${file.oldPath ?? ""}:${file.path}`}
                type="button"
                className="flex w-full min-w-0 items-center gap-1.5 px-1 text-left"
                style={{
                  height: GIT_GRAPH_FILE_ROW_HEIGHT,
                  color: "var(--cs-text-primary)",
                  background: selected
                    ? "color-mix(in srgb, var(--cs-primary) 14%, transparent)"
                    : opening
                      ? "color-mix(in srgb, var(--cs-primary) 10%, transparent)"
                      : "transparent",
                  borderRadius: 3,
                  boxShadow: selected
                    ? "inset 0 0 0 1px color-mix(in srgb, var(--cs-primary) 55%, transparent)"
                    : undefined,
                }}
                title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                onClick={(event) => {
                  event.stopPropagation();
                  onFileSelect(file);
                }}
              >
                <span
                  className="inline-flex shrink-0 text-[14px]"
                  style={{ color: fileVisual.color }}
                >
                  {opening ? <LoadingOutlined /> : fileVisual.icon}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-[12px]"
                  style={{
                    opacity: file.status === "deleted" ? 0.62 : 1,
                    textDecoration:
                      file.status === "deleted" ? "line-through" : undefined,
                  }}
                >
                  {file.oldPath ? (
                    <span
                      className="mr-1 text-[10px]"
                      style={{ color: "var(--cs-text-tertiary)" }}
                    >
                      {file.oldPath} →
                    </span>
                  ) : null}
                  {fileName}
                  {parentPath ? (
                    <span
                      className="ml-1.5 text-[10px]"
                      style={{ color: "var(--cs-text-tertiary)" }}
                    >
                      {parentPath}
                    </span>
                  ) : null}
                </span>
                <span
                  className="inline-flex w-4 shrink-0 justify-center text-[11px] font-semibold"
                  style={{ color: badge.color }}
                >
                  {badge.label}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
