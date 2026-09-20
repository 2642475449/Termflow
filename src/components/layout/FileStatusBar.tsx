import { FolderOutlined, RightOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { getStatusPathSegments } from "@/lib/fileStatus";
import { getFileIconByName } from "@/lib/fileIcon";
import { revealExplorerPath } from "@/lib/explorer";
import { useAppStore } from "@/store";
import { useFileEditorStatusStore } from "@/store/slices/fileEditorStatus";

export function FileStatusPath({ path, projectPath }: { path: string; projectPath?: string }) {
  const { t } = useTranslation();
  const segments = getStatusPathSegments(path, projectPath);
  return <nav className="app-statusbar-file-path" aria-label={t("statusBar.file.navigation")}>
    <ol className="app-statusbar-path-list">
      {segments.map((segment, index) => <li key={segment.path} className="app-statusbar-path-item">
        {index > 0 && <RightOutlined className="app-statusbar-path-separator" aria-hidden="true" />}
        <button type="button" className={`app-statusbar-path-button${segment.kind === "file" ? " app-statusbar-filename" : ""}`}
          title={segment.path} aria-current={segment.kind === "file" ? "page" : undefined}
          onClick={() => revealExplorerPath(segment.path, segment.kind)}>
          {segment.kind === "file"
            ? <span className="app-statusbar-type-icon" aria-hidden="true">{getFileIconByName(segment.label).icon}</span>
            : index === 0 && <FolderOutlined className="app-statusbar-file-icon" aria-hidden="true" />}
          {segment.label}
        </button>
      </li>)}
    </ol>
  </nav>;
}

export function FileStatusDetails({ tabId, path }: { tabId: string; path: string }) {
  const { t } = useTranslation();
  const editor = useFileEditorStatusStore((state) => state.editors[tabId]);
  const document = useAppStore((state) => state.fileDocuments[path]);
  const dirty = useAppStore((state) => state.tabsById[tabId]?.dirty ?? false);
  const extension = path.split(/[\\/]/).pop()?.split(".").slice(1).pop();
  const language = editor?.language || extension?.toUpperCase() || t("statusBar.file.file");
  const stateLabel = document?.readOnly ? t("fileTabs.readOnly")
    : dirty ? t("statusBar.file.unsaved") : null;
  const formatHint = editor ? `${editor.eol} · ${t(editor.insertSpaces ? "statusBar.file.spaces" : "statusBar.file.tabs", { count: editor.tabSize })}` : undefined;
  return <div className="app-statusbar-file-details">
    {editor && <span className="tabular-nums">{t("statusBar.file.position", { line: editor.line, column: editor.column })}</span>}
    <span className="app-statusbar-file-type" title={formatHint}>{language}</span>
    {stateLabel && <span className={dirty ? "text-[var(--cs-warning)]" : undefined}>{stateLabel}</span>}
  </div>;
}
