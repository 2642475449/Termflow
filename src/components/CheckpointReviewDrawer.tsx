import {
  Alert,
  Button,
  Drawer,
  Empty,
  Modal,
  Select,
  Spin,
  Tag,
  Tooltip,
  message,
} from "antd";
import {
  CaretDownOutlined,
  CaretRightOutlined,
  CheckOutlined,
  CloseOutlined,
  HistoryOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  RollbackOutlined,
  SafetyCertificateOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentTurnReview,
  CheckpointChangedFile,
  GitDiffContentResult,
  GitDiffHunk,
  Session,
} from "@/types";
import {
  checkpointDiscardTurn,
  checkpointFileDiff,
  checkpointFileHunks,
  checkpointListTurns,
  checkpointMarkReviewed,
  checkpointRejectFile,
  checkpointRestoreTurn,
  checkpointSetFileDecision,
  completeAgentTurn,
} from "@/lib/api";
import {
  checkpointSessionUpdates,
  getRemainingCheckpointStats,
  isOpenCheckpointReview,
} from "@/lib/checkpointReview";
import {
  buildCollapsedContextSections,
  buildUnifiedCheckpointDiffRows,
  type UnifiedDiffRow,
} from "@/lib/checkpointDiff";
import { getFileIconByName } from "@/lib/fileIcon";
import { useAppStore } from "@/store";

interface CheckpointReviewDrawerProps {
  open: boolean;
  projectPath: string;
  session: Session | null;
  onClose: () => void;
  embedded?: boolean;
}

interface PendingReviewConfirmation {
  key: string;
  title: string;
  description?: string;
  action: () => Promise<unknown>;
}

function decisionColor(decision: string) {
  if (decision === "accepted") return "green";
  if (decision === "rejected") return "red";
  return "default";
}

function splitReviewPath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const separator = normalized.lastIndexOf("/");
  return separator < 0
    ? { parentPath: "", fileName: normalized }
    : { parentPath: normalized.slice(0, separator + 1), fileName: normalized.slice(separator + 1) };
}

function renderFileIdentity(file: CheckpointChangedFile) {
  const { parentPath, fileName } = splitReviewPath(file.path);
  const fileVisual = getFileIconByName(fileName);
  const rejected = file.decision === "rejected";
  return (
    <span className="flex min-w-0 items-center gap-2" title={file.path}>
      <span
        className="inline-flex shrink-0 items-center justify-center text-sm"
        style={{ color: fileVisual.color }}
      >
        {fileVisual.icon}
      </span>
      <span className="min-w-0 truncate text-xs">
        {parentPath && <span style={{ color: "var(--cs-text-tertiary)" }}>{parentPath}</span>}
        <span style={{ color: "var(--cs-text-primary)" }}>{fileName}</span>
      </span>
      <span className="shrink-0 text-xs tabular-nums" style={{ color: "var(--cs-success)" }}>
        +{rejected ? 0 : file.insertions ?? 0}
      </span>
      <span className="shrink-0 text-xs tabular-nums" style={{ color: "var(--cs-error)" }}>
        -{rejected ? 0 : file.deletions ?? 0}
      </span>
    </span>
  );
}

function UnifiedDiffRowView({ row }: { row: UnifiedDiffRow }) {
  const added = row.origin === "+";
  const removed = row.origin === "-";
  const accent = added
    ? "var(--cs-success)"
    : removed
      ? "var(--cs-error)"
      : "transparent";
  return (
    <div
      className="grid min-w-0"
      style={{
        gridTemplateColumns: "4.5ch 4.5ch 2.25ch minmax(28ch, 1fr)",
        background: added
          ? "color-mix(in srgb, var(--cs-success) 16%, transparent)"
          : removed
            ? "color-mix(in srgb, var(--cs-error) 16%, transparent)"
            : "transparent",
        boxShadow: added || removed ? `inset 3px 0 ${accent}` : undefined,
      }}
    >
      <span
        className="select-none pr-2 text-right tabular-nums"
        style={{ color: "var(--cs-text-tertiary)" }}
      >
        {row.oldLineNumber ?? ""}
      </span>
      <span
        className="select-none pr-2 text-right tabular-nums"
        style={{ color: "var(--cs-text-tertiary)" }}
      >
        {row.newLineNumber ?? ""}
      </span>
      <span
        className="select-none text-center"
        style={{ color: added || removed ? accent : "var(--cs-text-tertiary)" }}
      >
        {row.origin === " " ? "" : row.origin}
      </span>
      <span
        className="min-w-max whitespace-pre pr-5"
        style={{ color: "var(--cs-text-primary)" }}
        title={row.content}
      >
        {row.content || " "}
      </span>
    </div>
  );
}

function UnifiedDiffView({
  hunks,
  fontSize,
  originalContent,
  modifiedContent,
}: {
  hunks: GitDiffHunk[];
  fontSize: number;
  originalContent: string;
  modifiedContent: string;
}) {
  const { t } = useTranslation();
  const [expandedContext, setExpandedContext] = useState<Set<number>>(() => new Set());
  const contextSections = useMemo(
    () => buildCollapsedContextSections(hunks, originalContent, modifiedContent),
    [hunks, modifiedContent, originalContent],
  );
  const contextByPosition = useMemo(
    () => new Map(contextSections.map((section) => [section.position, section])),
    [contextSections],
  );
  if (hunks.length === 0) {
    return <Empty className="mt-20" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  const rowHeight = Math.max(20, fontSize * 1.55);
  const renderContext = (position: number) => {
    const section = contextByPosition.get(position);
    if (!section) return null;
    const expanded = expandedContext.has(position);
    return (
      <div key={`context-${position}`}>
        <button
          type="button"
          className="my-1 flex h-8 w-full items-center gap-2 px-3 text-left text-[11px] transition-colors hover:bg-[var(--cs-bg-hover)]"
          style={{
            background: "color-mix(in srgb, var(--cs-text-primary) 5%, transparent)",
            color: "var(--cs-text-secondary)",
            borderBlock: "1px solid var(--cs-border-sidebar)",
          }}
          aria-expanded={expanded}
          onClick={() => setExpandedContext((current) => {
            const next = new Set(current);
            if (next.has(position)) next.delete(position);
            else next.add(position);
            return next;
          })}
        >
          {expanded ? <CaretDownOutlined /> : <CaretRightOutlined />}
          <span>{t("checkpointReview.unchangedLines", { count: section.rows.length })}</span>
        </button>
        {expanded && section.rows.map((row, rowIndex) => (
          <div
            key={`context-${position}-row-${rowIndex}`}
            className="min-w-[40ch]"
            style={{ minHeight: rowHeight, lineHeight: `${rowHeight}px` }}
          >
            <UnifiedDiffRowView row={row} />
          </div>
        ))}
      </div>
    );
  };

  return (
    <div
      className="overflow-x-auto py-2"
      style={{
        fontFamily: "'Geist Mono', 'Cascadia Mono', Consolas, monospace",
        fontSize: Math.max(11, fontSize - 1),
      }}
    >
      {hunks.map((hunk, hunkIndex) => {
        const rows = buildUnifiedCheckpointDiffRows(hunk);
        return (
          <div key={`${hunk.header}-${hunkIndex}`}>
            {renderContext(hunkIndex)}
            {rows.map((row, rowIndex) => {
              return row.annotation ? (
                <div
                  key={`${hunk.header}-annotation-${rowIndex}`}
                  className="min-w-[64ch] px-3 italic"
                  style={{
                    minHeight: rowHeight,
                    lineHeight: `${rowHeight}px`,
                    color: "var(--cs-text-tertiary)",
                  }}
                >
                  {row.annotation}
                </div>
              ) : (
                <div
                  key={`${hunk.header}-row-${rowIndex}`}
                  className="min-w-[40ch]"
                  style={{ minHeight: rowHeight, lineHeight: `${rowHeight}px` }}
                >
                  <UnifiedDiffRowView row={row} />
                </div>
              );
            })}
          </div>
        );
      })}
      {renderContext(hunks.length)}
    </div>
  );
}

function GitlinkPreview({
  originalOid,
  modifiedOid,
}: {
  originalOid: string;
  modifiedOid: string;
}) {
  const { t } = useTranslation();
  const shortOid = (oid: string) => oid ? oid.slice(0, 8) : t("checkpointReview.gitlinkMissing");
  return (
    <div
      className="m-3 flex min-h-12 items-center gap-3 rounded-md border px-3 py-2"
      style={{
        borderColor: "var(--cs-border-sidebar)",
        background: "color-mix(in srgb, var(--cs-primary) 7%, var(--cs-bg-primary))",
      }}
    >
      <InfoCircleOutlined className="shrink-0" style={{ color: "var(--cs-primary)" }} />
      <span className="text-xs" style={{ color: "var(--cs-text-secondary)" }}>
        {t("checkpointReview.gitlinkChanged")}
      </span>
      <span
        className="ml-auto shrink-0 font-mono text-xs tabular-nums"
        style={{ color: "var(--cs-text-primary)" }}
      >
        {shortOid(originalOid)} → {shortOid(modifiedOid)}
      </span>
    </div>
  );
}

function DiffLoadFallback({ error, onRetry }: { error: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      className="m-3 rounded-md border"
      style={{
        borderColor: "color-mix(in srgb, var(--cs-warning) 35%, var(--cs-border-sidebar))",
        background: "color-mix(in srgb, var(--cs-warning) 6%, var(--cs-bg-primary))",
      }}
      role="status"
    >
      <div className="flex min-h-11 items-center gap-2 px-3 py-1.5">
        <WarningOutlined className="shrink-0" style={{ color: "var(--cs-warning)" }} />
        <span className="min-w-0 flex-1 text-xs" style={{ color: "var(--cs-text-secondary)" }}>
          {t("checkpointReview.previewUnavailable")}
        </span>
        <Button size="small" type="text" icon={<ReloadOutlined />} onClick={onRetry}>
          {t("checkpointReview.retry")}
        </Button>
        <details className="shrink-0 text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
          <summary className="cursor-pointer select-none">{t("checkpointReview.errorDetails")}</summary>
          <div
            className="mt-2 max-w-[72ch] whitespace-pre-wrap break-all border-t py-2 font-mono text-[11px]"
            style={{ borderColor: "var(--cs-border-sidebar)" }}
          >
            {error}
          </div>
        </details>
      </div>
    </div>
  );
}

interface FileDiffSectionProps {
  file: CheckpointChangedFile;
  turn: AgentTurnReview;
  projectPath: string;
  fontSize: number;
  operating: string | null;
  scrollRoot: HTMLDivElement | null;
  registerElement: (path: string, element: HTMLElement | null) => void;
  onAccept: (file: CheckpointChangedFile) => void;
  onReject: (file: CheckpointChangedFile) => void;
}

function FileDiffSection({
  file,
  turn,
  projectPath,
  fontSize,
  operating,
  scrollRoot,
  registerElement,
  onAccept,
  onReject,
}: FileDiffSectionProps) {
  const { t } = useTranslation();
  const sectionRef = useRef<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [diff, setDiff] = useState<GitDiffContentResult | null>(null);
  const [hunks, setHunks] = useState<GitDiffHunk[]>([]);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [hunksError, setHunksError] = useState<string | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);

  const setSectionElement = useCallback((element: HTMLElement | null) => {
    sectionRef.current = element;
    registerElement(file.path, element);
  }, [file.path, registerElement]);

  useEffect(() => {
    if (!expanded || shouldLoad || !sectionRef.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { root: scrollRoot, rootMargin: "600px 0px" },
    );
    observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, [expanded, scrollRoot, shouldLoad]);

  useEffect(() => {
    if (!shouldLoad || !turn.result) {
      setDiff(null);
      setHunks([]);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    setHunksError(null);
    Promise.allSettled([
      checkpointFileDiff(projectPath, turn.id, file.path),
      checkpointFileHunks(projectPath, turn.id, file.path),
    ])
      .then(([nextDiff, nextHunks]) => {
        if (cancelled) return;
        if (nextDiff.status === "fulfilled") setDiff(nextDiff.value);
        else {
          setDiff(null);
          setDiffError(String(nextDiff.reason));
        }
        if (nextHunks.status === "fulfilled") setHunks(nextHunks.value.hunks);
        else {
          setHunks([]);
          setHunksError(String(nextHunks.reason));
        }
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file.path, loadRevision, projectPath, shouldLoad, turn.id, turn.result, turn.updatedAt]);

  const previewError = diffError
    ?? (diff && !diff.isBinary && diff.contentKind !== "gitlink" ? hunksError : null);

  const decidedHunks = hunks.filter((hunk) => hunk.decision && hunk.decision !== "pending");
  const fileDecisionLockedByHunks = decidedHunks.length > 0;
  const acceptKey = `accept-file:${file.path}`;
  const rejectKey = `reject-file:${file.path}`;

  return (
    <section
      ref={setSectionElement}
      data-checkpoint-file={file.path}
      className="overflow-clip"
      style={{
        borderBottom: "1px solid var(--cs-border-sidebar)",
        background: "var(--cs-bg-primary)",
      }}
    >
      <div
        className="sticky top-0 z-10 flex min-w-0 items-center gap-1 px-3 py-1.5"
        style={{
          borderBottom: expanded ? "1px solid var(--cs-border-sidebar)" : undefined,
          background: "color-mix(in srgb, var(--cs-bg-primary) 94%, var(--cs-text-primary))",
        }}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <CaretDownOutlined /> : <CaretRightOutlined />}
          <span className="min-w-0 flex-1">{renderFileIdentity(file)}</span>
          {file.decision !== "pending" && (
            <Tag color={decisionColor(file.decision)} className="m-0 shrink-0 text-[10px]">
              {t(`checkpointReview.decision.${file.decision}`)}
            </Tag>
          )}
        </button>
        <Tooltip title={fileDecisionLockedByHunks
          ? t("checkpointReview.fileDecisionLockedByHunks")
          : t("checkpointReview.acceptFile")}>
          <span>
            <Button
              size="small"
              type="text"
              shape="circle"
              icon={<CheckOutlined />}
              loading={operating === acceptKey}
              disabled={fileDecisionLockedByHunks || file.decision === "accepted"}
              aria-label={t("checkpointReview.acceptFile")}
              style={file.decision === "accepted" ? { color: "var(--cs-success)" } : undefined}
              onClick={() => onAccept(file)}
            />
          </span>
        </Tooltip>
        <Tooltip title={fileDecisionLockedByHunks
          ? t("checkpointReview.fileDecisionLockedByHunks")
          : t("checkpointReview.rejectFile")}>
          <span>
            <Button
              danger
              size="small"
              type="text"
              shape="circle"
              icon={<CloseOutlined />}
              loading={operating === rejectKey}
              disabled={fileDecisionLockedByHunks || file.decision === "rejected"}
              aria-label={t("checkpointReview.rejectFile")}
              onClick={() => onReject(file)}
            />
          </span>
        </Tooltip>
      </div>
      {expanded && (
        <div className="min-h-32">
          {!turn.result ? (
            <Empty className="my-8" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : diffLoading || !shouldLoad ? (
            <div className="flex h-32 items-center justify-center"><Spin /></div>
          ) : previewError ? (
            <DiffLoadFallback
              error={previewError}
              onRetry={() => setLoadRevision((revision) => revision + 1)}
            />
          ) : diff?.contentKind === "gitlink" ? (
            <GitlinkPreview
              originalOid={diff.originalContent}
              modifiedOid={diff.modifiedContent}
            />
          ) : diff?.isBinary ? (
            <Alert className="m-3" type="info" showIcon message={t("checkpointReview.binary")} />
          ) : diff ? (
            <UnifiedDiffView
              hunks={hunks}
              fontSize={fontSize}
              originalContent={diff.originalContent}
              modifiedContent={diff.modifiedContent}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}

function CheckpointReviewDrawer({
  open,
  projectPath,
  session,
  onClose,
  embedded = false,
}: CheckpointReviewDrawerProps) {
  const { t } = useTranslation();
  const sessionId = session?.id ?? null;
  const updateSession = useAppStore((state) => state.updateSession);
  const editorFontSize = useAppStore((state) => state.editorFontSize);
  const [turns, setTurns] = useState<AgentTurnReview[]>([]);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [operating, setOperating] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingReviewConfirmation | null>(null);
  const reviewScrollRef = useRef<HTMLDivElement | null>(null);
  const fileElementsRef = useRef(new Map<string, HTMLElement>());
  const previousTurnIdRef = useRef<string | null>(null);

  const selectedTurn = useMemo(
    () => turns.find((turn) => turn.id === selectedTurnId) ?? null,
    [selectedTurnId, turns],
  );
  const selectedTurnStats = useMemo(
    () => selectedTurn ? getRemainingCheckpointStats(selectedTurn) : null,
    [selectedTurn],
  );
  const selectedTurnIndex = selectedTurn
    ? turns.findIndex((turn) => turn.id === selectedTurn.id)
    : -1;
  const selectedTurnNumber = selectedTurnIndex >= 0
    ? turns.length - selectedTurnIndex
    : 0;
  const laterTurnCount = Math.max(0, selectedTurnIndex);

  const refreshTurns = useCallback(async (preferredTurnId?: string | null) => {
    if (!open || !sessionId) return null;
    setLoading(true);
    try {
      const nextTurns = await checkpointListTurns(projectPath, sessionId);
      setTurns(nextTurns);
      updateSession(sessionId, checkpointSessionUpdates(nextTurns));
      const targetId =
        preferredTurnId && nextTurns.some((turn) => turn.id === preferredTurnId)
          ? preferredTurnId
          : nextTurns.find(isOpenCheckpointReview)?.id ?? nextTurns[0]?.id ?? null;
      setSelectedTurnId(targetId);
      return nextTurns;
    } catch (error) {
      message.error(`${t("checkpointReview.loadFailed")}: ${String(error)}`);
      return null;
    } finally {
      setLoading(false);
    }
  }, [open, projectPath, sessionId, t, updateSession]);

  useEffect(() => {
    if (!open) return;
    void refreshTurns();
  }, [open, refreshTurns]);

  useEffect(() => {
    const firstPath = selectedTurn?.files[0]?.path ?? null;
    setSelectedPath((current) =>
      current && selectedTurn?.files.some((file) => file.path === current) ? current : firstPath,
    );
    if (previousTurnIdRef.current !== (selectedTurn?.id ?? null)) {
      fileElementsRef.current.clear();
      reviewScrollRef.current?.scrollTo({ top: 0 });
      previousTurnIdRef.current = selectedTurn?.id ?? null;
    }
  }, [selectedTurn]);

  const runOperation = useCallback(async (
    key: string,
    action: () => Promise<unknown>,
    closeWhenReviewComplete = false,
  ) => {
    if (!selectedTurn) return;
    setOperating(key);
    try {
      await action();
      const nextTurns = await refreshTurns(selectedTurn.id);
      message.success(t("checkpointReview.saved"));
      if (closeWhenReviewComplete && nextTurns) {
        const refreshedSelectedTurn = nextTurns.find((turn) => turn.id === selectedTurn.id);
        const nextOpenTurn = refreshedSelectedTurn && isOpenCheckpointReview(refreshedSelectedTurn)
          ? refreshedSelectedTurn
          : nextTurns.find(isOpenCheckpointReview);
        if (nextOpenTurn) {
          setSelectedTurnId(nextOpenTurn.id);
        } else {
          onClose();
        }
      }
    } catch (error) {
      message.error(`${t("checkpointReview.operationFailed")}: ${String(error)}`);
    } finally {
      setOperating(null);
    }
  }, [onClose, refreshTurns, selectedTurn, t]);

  const confirmPendingOperation = useCallback(async () => {
    if (!pendingConfirmation) return;
    await runOperation(pendingConfirmation.key, pendingConfirmation.action);
    setPendingConfirmation(null);
  }, [pendingConfirmation, runOperation]);

  const registerFileElement = useCallback((path: string, element: HTMLElement | null) => {
    if (element) fileElementsRef.current.set(path, element);
    else fileElementsRef.current.delete(path);
  }, []);

  const jumpToFile = useCallback((path: string) => {
    setSelectedPath(path);
    fileElementsRef.current.get(path)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const acceptFile = useCallback((file: CheckpointChangedFile) => {
    if (!selectedTurn) return;
    void runOperation(
      `accept-file:${file.path}`,
      () => checkpointSetFileDecision(projectPath, selectedTurn.id, file.path, "accepted"),
      true,
    );
  }, [projectPath, runOperation, selectedTurn]);

  const rejectFile = useCallback((file: CheckpointChangedFile) => {
    if (!selectedTurn) return;
    setPendingConfirmation({
      key: `reject-file:${file.path}`,
      title: t("checkpointReview.rejectFileConfirm"),
      action: () => checkpointRejectFile(projectPath, selectedTurn.id, file.path),
    });
  }, [projectPath, selectedTurn, t]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={embedded ? "100%" : "min(1180px, 92vw)"}
      destroyOnClose
      getContainer={embedded ? false : undefined}
      mask={!embedded}
      rootStyle={embedded ? { position: "absolute", inset: 0 } : undefined}
      push={false}
      closable={!embedded}
      title={embedded ? undefined : (
        <div className="flex items-center gap-2">
          <SafetyCertificateOutlined style={{ color: "var(--cs-primary)" }} />
          <span>{t("checkpointReview.title")}</span>
          {session && <span className="text-xs font-normal" style={{ color: "var(--cs-text-tertiary)" }}>· {session.name}</span>}
        </div>
      )}
      styles={{ body: { padding: 0, overflow: "hidden" } }}
    >
      {loading ? (
        <div className="flex h-full items-center justify-center"><Spin /></div>
      ) : turns.length === 0 ? (
        <Empty className="mt-20" description={t("checkpointReview.empty")} />
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex min-h-11 items-center gap-2 px-3 py-2" style={{ borderBottom: "1px solid var(--cs-border-sidebar)" }}>
            <HistoryOutlined style={{ color: "var(--cs-text-tertiary)" }} />
            <Select
              size="small"
              value={selectedTurnId}
              className="min-w-0 flex-1"
              onChange={setSelectedTurnId}
              options={turns.map((turn, index) => ({
                value: turn.id,
                label: `${t("checkpointReview.turnLabel", { index: turns.length - index })} · ${new Date(turn.startedAt).toLocaleString()}`,
              }))}
            />
            {selectedTurn && (
              <>
                <span className="shrink-0 whitespace-nowrap text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
                  {selectedTurnStats?.files ?? 0} {t("checkpointReview.files")} ·
                  <span style={{ color: "var(--cs-success)" }}> +{selectedTurnStats?.additions ?? 0}</span>
                  <span style={{ color: "var(--cs-error)" }}> -{selectedTurnStats?.deletions ?? 0}</span>
                </span>
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  <Tooltip title={t("checkpointReview.restoreTurn", { index: selectedTurnNumber })}>
                    <Button
                      type="text"
                      size="small"
                      shape="circle"
                      icon={<RollbackOutlined />}
                      aria-label={t("checkpointReview.restoreTurn", { index: selectedTurnNumber })}
                      loading={operating === "restore-turn"}
                      disabled={!selectedTurn.result}
                      onClick={() => setPendingConfirmation({
                        key: "restore-turn",
                        title: t("checkpointReview.restoreConfirm", { index: selectedTurnNumber }),
                        description: t("checkpointReview.restoreConfirmDesc", {
                          index: selectedTurnNumber,
                          count: laterTurnCount,
                        }),
                        action: () => checkpointRestoreTurn(projectPath, selectedTurn.id),
                      })}
                    />
                  </Tooltip>
                  {isOpenCheckpointReview(selectedTurn) && (
                    <>
                      <Tooltip title={t("checkpointReview.markReviewed")}>
                        <Button
                          type="text"
                          size="small"
                          shape="circle"
                          icon={<CheckOutlined />}
                          aria-label={t("checkpointReview.markReviewed")}
                          loading={operating === "mark-reviewed"}
                          onClick={() => void runOperation(
                            "mark-reviewed",
                            () => checkpointMarkReviewed(projectPath, selectedTurn.id),
                            true,
                          )}
                        />
                      </Tooltip>
                      <Tooltip title={t("checkpointReview.discardTurn")}>
                        <Button
                          danger
                          type="text"
                          size="small"
                          shape="circle"
                          icon={<CloseOutlined />}
                          aria-label={t("checkpointReview.discardTurn")}
                          loading={operating === "discard-turn"}
                          onClick={() => setPendingConfirmation({
                            key: "discard-turn",
                            title: t("checkpointReview.discardTurnConfirm", { index: selectedTurnNumber }),
                            description: t("checkpointReview.discardTurnConfirmDesc", {
                              index: selectedTurnNumber,
                              count: laterTurnCount,
                              files: selectedTurnStats?.files ?? 0,
                              additions: selectedTurnStats?.additions ?? 0,
                              deletions: selectedTurnStats?.deletions ?? 0,
                            }),
                            action: () => checkpointDiscardTurn(projectPath, selectedTurn.id),
                          })}
                        />
                      </Tooltip>
                    </>
                  )}
                </div>
              </>
            )}
          </div>

          {selectedTurn?.reviewStatus === "running" && (
            <Alert
              className="m-3 mb-0"
              type="info"
              showIcon
              message={t("checkpointReview.running")}
              action={session ? (
                <Button
                  size="small"
                  loading={operating === "complete-turn"}
                  onClick={() => void runOperation("complete-turn", () => completeAgentTurn(session.id))}
                >
                  {t("checkpointReview.completeTurn")}
                </Button>
              ) : undefined}
            />
          )}

          <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {!selectedTurn?.files.length ? (
              <Empty className="mt-20" description={t("checkpointReview.noChanges")} />
            ) : (
              <>
                {selectedTurn.files.length > 1 && (
                  <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: "1px solid var(--cs-border-sidebar)" }}>
                    <Select
                      size="small"
                      showSearch
                      className="min-w-0 flex-1"
                      value={selectedPath}
                      optionFilterProp="label"
                      onChange={jumpToFile}
                      options={selectedTurn.files.map((file) => ({
                        value: file.path,
                        label: file.path,
                      }))}
                    />
                    <span className="shrink-0 text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
                      {selectedTurn.files.length} {t("checkpointReview.files")}
                    </span>
                  </div>
                )}
                <div ref={reviewScrollRef} className="min-h-0 flex-1 overflow-y-auto">
                  <div className="flex min-w-0 flex-col">
                    {selectedTurn.files.map((file) => (
                      <FileDiffSection
                        key={file.path}
                        file={file}
                        turn={selectedTurn}
                        projectPath={projectPath}
                        fontSize={editorFontSize}
                        operating={operating}
                        scrollRoot={reviewScrollRef.current}
                        registerElement={registerFileElement}
                        onAccept={acceptFile}
                        onReject={rejectFile}
                      />
                    ))}
                  </div>
                </div>
              </>
            )}
          </main>
        </div>
      )}
      <Modal
        open={Boolean(pendingConfirmation)}
        title={pendingConfirmation?.title}
        okText={t("common.confirm")}
        cancelText={t("common.cancel")}
        okButtonProps={{ danger: true }}
        confirmLoading={operating === pendingConfirmation?.key}
        closable={!operating}
        maskClosable={!operating}
        onOk={() => void confirmPendingOperation()}
        onCancel={() => {
          if (!operating) setPendingConfirmation(null);
        }}
        destroyOnHidden
      >
        {pendingConfirmation?.description ?? pendingConfirmation?.title}
      </Modal>
    </Drawer>
  );
}

export default CheckpointReviewDrawer;
