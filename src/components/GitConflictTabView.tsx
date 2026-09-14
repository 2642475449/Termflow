import { CheckOutlined, CopyOutlined, ReloadOutlined, WarningOutlined } from "@ant-design/icons";
import { Editor, loader } from "@monaco-editor/react";
import { Alert, Button, Empty, Spin, Tag, message } from "antd";
import * as monaco from "monaco-editor";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { gitConflictDetail, gitResolveConflict } from "@/lib/api";
import { getGitConflictResolutionLabelKeys, getGitOperationLabelKey } from "@/lib/gitOperationState";
import { requestGitStatusRefresh } from "@/lib/gitStatusEvents";
import { getMonacoLanguage, getMonacoThemeName, getMonacoTypography } from "@/lib/monaco";
import { useAppStore } from "@/store";
import { useGitStatusStore } from "@/store/slices/gitStatus";
import type { GitConflictDetail } from "@/types";

loader.config({ monaco });

type ConflictSource = "base" | "ours" | "theirs";

interface GitConflictTabViewProps {
  projectPath: string;
  filePath: string;
  isBinary: boolean;
}

interface ConflictSourcePaneProps {
  title: string;
  content: string | null;
  language: string;
  theme: string;
  typography: ReturnType<typeof getMonacoTypography>;
  actionLabel?: string;
  deleteActionLabel?: string;
  disabled: boolean;
  onUse?: () => void;
  onAcceptDeletion?: () => void;
  unavailableLabel: string;
}

function hasUnresolvedConflictMarkers(content: string) {
  return /^(?:<{7,}|={7,}|>{7,})(?:\s|$)/m.test(content);
}

function ConflictSourcePane({
  title,
  content,
  language,
  theme,
  typography,
  actionLabel,
  deleteActionLabel,
  disabled,
  onUse,
  onAcceptDeletion,
  unavailableLabel,
}: ConflictSourcePaneProps) {
  const isDeletion = content === null;

  return (
    <section className="flex min-h-0 flex-col bg-[var(--cs-bg-app)]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--cs-border-sidebar)] px-3">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--cs-text-primary)]">{title}</span>
        {isDeletion && onAcceptDeletion && deleteActionLabel ? (
          <Button size="small" danger disabled={disabled} onClick={onAcceptDeletion}>{deleteActionLabel}</Button>
        ) : onUse && actionLabel ? (
          <Button size="small" icon={<CopyOutlined />} disabled={disabled} onClick={onUse}>{actionLabel}</Button>
        ) : null}
      </div>
      {isDeletion ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={unavailableLabel} />
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <Editor
            height="100%"
            language={language}
            theme={theme}
            value={content}
            options={{
              readOnly: true,
              contextmenu: false,
              automaticLayout: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              renderWhitespace: "selection",
              wordWrap: "off",
              ...typography,
            }}
          />
        </div>
      )}
    </section>
  );
}

/** Git 冲突专用标签页：同时展示共同祖先、双方版本和可编辑的最终结果。 */
export function GitConflictTabView({ projectPath, filePath, isBinary }: GitConflictTabViewProps) {
  const { t } = useTranslation();
  const lightTheme = useAppStore((state) => state.lightTheme);
  const darkTheme = useAppStore((state) => state.darkTheme);
  const themeCategory = useAppStore((state) => state.themeCategory);
  const editorFontSize = useAppStore((state) => state.editorFontSize);
  const systemPrefersDark = useAppStore((state) => state.systemPrefersDark);
  const operationState = useGitStatusStore((state) => state.entries[projectPath]?.branchInfo?.operationState ?? "clean");
  const [detail, setDetail] = useState<GitConflictDetail | null>(null);
  const [result, setResult] = useState("");
  const [initialResult, setInitialResult] = useState("");
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);

  const isDark = useMemo(() => {
    if (themeCategory === "system") return systemPrefersDark;
    return themeCategory === "dark";
  }, [darkTheme, lightTheme, systemPrefersDark, themeCategory]);
  const language = useMemo(() => getMonacoLanguage(filePath), [filePath]);
  const theme = useMemo(() => getMonacoThemeName(isDark), [isDark]);
  const typography = useMemo(() => getMonacoTypography(Math.max(13, editorFontSize)), [editorFontSize]);
  const resolutionLabels = getGitConflictResolutionLabelKeys(operationState);
  const oursLabel = t(resolutionLabels.ours);
  const theirsLabel = t(resolutionLabels.theirs);
  const operationLabel = t(getGitOperationLabelKey(operationState));
  const hasMarkers = hasUnresolvedConflictMarkers(result);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const nextDetail = await gitConflictDetail(projectPath, filePath);
      setDetail(nextDetail);
      if (!nextDetail.hasConflict) {
        setResolved(true);
        return;
      }
      const merged = nextDetail.mergedContent ?? nextDetail.oursContent ?? nextDetail.theirsContent ?? "";
      setInitialResult(merged);
      setResult(merged);
      setResolved(false);
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [filePath, projectPath]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);

  const handleResolveAsDeletedSide = useCallback(async (resolution: "ours" | "theirs") => {
    setResolving(true);
    try {
      await gitResolveConflict(projectPath, filePath, resolution);
      setResolved(true);
      requestGitStatusRefresh(projectPath);
      message.success(t("sidebar.gitConflictResolverStageSuccess"));
    } catch (reason) {
      message.error(`${t("sidebar.gitConflictResolverResolveFailed")}: ${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setResolving(false);
    }
  }, [filePath, projectPath, t]);

  const handleStageResult = useCallback(async () => {
    if (hasMarkers) return;
    setResolving(true);
    try {
      await gitResolveConflict(projectPath, filePath, "edited", result);
      setInitialResult(result);
      setResolved(true);
      requestGitStatusRefresh(projectPath);
      message.success(t("sidebar.gitConflictResolverStageSuccess"));
    } catch (reason) {
      message.error(`${t("sidebar.gitConflictResolverResolveFailed")}: ${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setResolving(false);
    }
  }, [filePath, hasMarkers, projectPath, result, t]);

  if (loading) return <div className="flex h-full items-center justify-center"><Spin /></div>;

  if (loadError) {
    return <div className="p-4"><Alert type="error" showIcon message={t("sidebar.gitConflictResolverLoadFailed")} description={loadError} action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void loadDetail()}>{t("sidebar.gitConflictResolverReload")}</Button>} /></div>;
  }

  if (resolved || !detail?.hasConflict) {
    return <div className="p-4"><Alert type="success" showIcon message={t("sidebar.gitConflictResolverResolved")} description={t("sidebar.gitConflictResolverResolvedDescription", { operation: operationLabel })} action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void loadDetail()}>{t("sidebar.gitConflictResolverReload")}</Button>} /></div>;
  }

  if (isBinary) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3 p-4">
        <Alert type="warning" showIcon message={t("sidebar.gitConflictResolverBinary")} description={t("sidebar.gitConflictResolverBinaryDescription")} />
        <div className="flex flex-wrap gap-2">
          <Button type="primary" loading={resolving} onClick={() => void handleResolveAsDeletedSide("ours")}>{oursLabel}</Button>
          <Button loading={resolving} onClick={() => void handleResolveAsDeletedSide("theirs")}>{theirsLabel}</Button>
        </div>
      </div>
    );
  }

  const sourcePanes: Array<{ source: ConflictSource; title: string; content: string | null; actionLabel?: string; deleteActionLabel?: string }> = [
    { source: "base", title: t("sidebar.gitConflictResolverBase"), content: detail.baseContent },
    { source: "ours", title: oursLabel, content: detail.oursContent, actionLabel: t("sidebar.gitConflictResolverUseInResult", { version: oursLabel }), deleteActionLabel: t("sidebar.gitConflictResolverAcceptDeletion", { version: oursLabel }) },
    { source: "theirs", title: theirsLabel, content: detail.theirsContent, actionLabel: t("sidebar.gitConflictResolverUseInResult", { version: theirsLabel }), deleteActionLabel: t("sidebar.gitConflictResolverAcceptDeletion", { version: theirsLabel }) },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--cs-bg-app)]">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cs-border-sidebar)] px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <WarningOutlined className="text-[var(--cs-warning)]" />
            <span className="truncate text-sm font-semibold text-[var(--cs-text-primary)]">{t("sidebar.gitConflictResolverTitle")}</span>
            <Tag color="warning">{t("sidebar.gitConflictDetected")}</Tag>
          </div>
          <p className="m-0 mt-1 truncate text-xs text-[var(--cs-text-tertiary)]" title={filePath}>{filePath}</p>
        </div>
        <Button icon={<ReloadOutlined />} disabled={resolving} onClick={() => void loadDetail()}>{t("sidebar.gitConflictResolverReload")}</Button>
        <Button type="primary" icon={<CheckOutlined />} danger={hasMarkers} disabled={hasMarkers || resolving} loading={resolving} onClick={() => void handleStageResult()}>{t("sidebar.gitConflictResolverStage")}</Button>
      </div>

      <div className="shrink-0 border-b border-[var(--cs-border-sidebar)] px-3 py-2">
        <Alert type={hasMarkers ? "warning" : "info"} showIcon message={hasMarkers ? t("sidebar.gitConflictResolverMarkersRemain") : t("sidebar.gitConflictResolverIntro")} description={hasMarkers ? t("sidebar.gitConflictResolverMarkersRemainDescription") : t("sidebar.gitConflictResolverIntroDescription")} />
      </div>

      <div className="grid min-h-[220px] flex-1 grid-cols-1 gap-px overflow-hidden bg-[var(--cs-border-sidebar)] lg:grid-cols-3">
        {sourcePanes.map((pane) => (
          <ConflictSourcePane
            key={pane.source}
            title={pane.title}
            content={pane.content}
            language={language}
            theme={theme}
            typography={typography}
            actionLabel={pane.actionLabel}
            deleteActionLabel={pane.deleteActionLabel}
            disabled={resolving}
            unavailableLabel={t("sidebar.gitConflictResolverDeleted")}
            onUse={pane.source === "base" || pane.content === null ? undefined : () => setResult(pane.content ?? "")}
            onAcceptDeletion={pane.source === "base" || pane.content !== null ? undefined : () => void handleResolveAsDeletedSide(pane.source as "ours" | "theirs")}
          />
        ))}
      </div>

      <section className="flex min-h-[260px] flex-[1.15] flex-col border-t border-[var(--cs-border-sidebar)] bg-[var(--cs-bg-app)]">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--cs-border-sidebar)] px-3">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--cs-text-primary)]">{t("sidebar.gitConflictResolverResult")}</span>
          <Button size="small" disabled={resolving || result === initialResult} onClick={() => setResult(initialResult)}>{t("sidebar.gitConflictResolverReset")}</Button>
        </div>
        <div className="min-h-0 flex-1">
          <Editor
            height="100%"
            language={language}
            theme={theme}
            value={result}
            onChange={(value) => setResult(value ?? "")}
            options={{ contextmenu: false, automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, smoothScrolling: true, renderWhitespace: "selection", wordWrap: "off", ...typography }}
          />
        </div>
      </section>
    </div>
  );
}