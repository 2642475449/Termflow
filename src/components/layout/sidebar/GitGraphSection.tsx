import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button, message, Tooltip } from "antd";
import type { MenuProps } from "antd";
import {
  BranchesOutlined,
  CloseOutlined,
  CopyOutlined,
  DownOutlined,
  HistoryOutlined,
  LoadingOutlined,
  ReloadOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  gitGraphCommitDetail,
  gitFetch,
  gitGraphFileDiff,
  gitGraphHistory,
} from "@/lib/api";
import type {
  GitGraphChangedFile,
  GitGraphCommit,
  GitGraphCommitDetail,
} from "@/types";
import { useAppStore } from "@/store";
import {
  GIT_GRAPH_REFRESH_EVENT,
  shouldReloadGitGraphOnExpand,
} from "@/lib/gitGraphEvents";
import { GitGraphRenderer } from "./GitGraphRenderer";
import { splitWorktreeReferences } from "./gitGraphReferences";
import { linearizeFileHistoryCommits } from "@/lib/gitFileHistory";

const GRAPH_HOVER_CARD_WIDTH = 460;
const GRAPH_HOVER_CARD_OFFSET = 8;
const GRAPH_HOVER_CARD_MIN_TOP = 12;
const GRAPH_HOVER_CARD_ESTIMATED_HEIGHT = 340;
const GRAPH_PAGE_SIZE = 100;

function formatGraphCommitTime(timestampMs: number, locale = "zh-CN") {
  try {
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "long",
      day: "2-digit",
      hour: "numeric",
      minute: "numeric",
    }).format(new Date(timestampMs));
  } catch {
    return "";
  }
}

function formatGraphCommitRelativeTime(timestampMs: number, locale = "zh-CN") {
  const elapsedSeconds = Math.round((timestampMs - Date.now()) / 1000);
  const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
  ];

  try {
    const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    for (const [unit, seconds] of ranges) {
      if (Math.abs(elapsedSeconds) >= seconds) {
        return formatter.format(Math.round(elapsedSeconds / seconds), unit);
      }
    }
    return formatter.format(elapsedSeconds, "second");
  } catch {
    return "";
  }
}

function getGraphRefBadgeStyles(kind: string) {
  switch (kind) {
    case "head":
      return { background: "#59a4f9", color: "#0f172a" };
    case "remote":
      return { background: "#B180D7", color: "#1f1328" };
    case "tag":
      return { background: "#EA5C00", color: "#20130a" };
    default:
      return {
        background: "color-mix(in srgb, var(--cs-primary) 74%, var(--cs-bg-card-solid, var(--cs-bg-card)) 26%)",
        color: "color-mix(in srgb, var(--cs-bg-card-solid, var(--cs-bg-card)) 84%, black 16%)",
      };
  }
}

function CommitStats({
  detail,
  loading,
}: {
  detail: GitGraphCommitDetail | null;
  loading: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1 text-[11px] leading-[16px]">
      <span style={{ color: "var(--cs-text-secondary)" }}>
        {t("sidebar.gitGraphTooltipFilesChanged", {
          count: loading ? "--" : detail?.changedFiles ?? "--",
        })}
      </span>
      <span aria-hidden="true" style={{ color: "var(--cs-text-tertiary)" }}>,</span>
      <span style={{ color: "var(--cs-success)" }}>
        {t("sidebar.gitGraphTooltipInsertions", {
          count: loading ? "--" : detail?.insertions ?? "--",
        })}
      </span>
      <span aria-hidden="true" style={{ color: "var(--cs-text-tertiary)" }}>,</span>
      <span style={{ color: "var(--cs-error)" }}>
        {t("sidebar.gitGraphTooltipDeletions", {
          count: loading ? "--" : detail?.deletions ?? "--",
        })}
      </span>
    </div>
  );
}

interface GitGraphSectionProps {
  projectPath: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  sectionTitle: string;
  refreshText: string;
  placeholderText: string;
  fileHistoryPath?: string | null;
  onClearFileHistory?: () => void;
}

export function GitGraphSection({
  projectPath,
  collapsed,
  onToggleCollapse,
  sectionTitle,
  refreshText,
  placeholderText,
  fileHistoryPath = null,
  onClearFileHistory,
}: GitGraphSectionProps) {
  const { i18n, t } = useTranslation();
  const openGitDiffTab = useAppStore((state) => state.openGitDiffTab);
  const [graphCommits, setGraphCommits] = useState<GitGraphCommit[]>([]);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphFetching, setGraphFetching] = useState(false);
  const [graphHasMore, setGraphHasMore] = useState(true);
  const [graphInitialized, setGraphInitialized] = useState(false);
  const [graphVisible, setGraphVisible] = useState(false);
  const [graphHover, setGraphHover] = useState<{ commit: GitGraphCommit; rect: DOMRect } | null>(null);
  const [graphHoverDetail, setGraphHoverDetail] = useState<GitGraphCommitDetail | null>(null);
  const [graphHoverLoading, setGraphHoverLoading] = useState(false);
  const [selectedCommit, setSelectedCommit] = useState<GitGraphCommit | null>(null);
  const [selectedCommitDetail, setSelectedCommitDetail] = useState<GitGraphCommitDetail | null>(null);
  const [selectedCommitLoading, setSelectedCommitLoading] = useState(false);
  const [selectedCommitError, setSelectedCommitError] = useState(false);
  const [selectedGraphFileKey, setSelectedGraphFileKey] = useState<string | null>(null);
  const [openingGraphDiffKey, setOpeningGraphDiffKey] = useState<string | null>(null);

  const graphHoverDetailCacheRef = useRef<Map<string, GitGraphCommitDetail>>(new Map());
  const graphHoverCloseTimerRef = useRef<number | null>(null);
  const graphHoverCardActiveRef = useRef(false);
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const graphLoadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const graphLoadingRef = useRef(false);
  const graphLoadRequestRef = useRef(0);
  const graphFetchingRef = useRef(false);
  const graphProjectPathRef = useRef(projectPath);
  const previousCollapsedRef = useRef(collapsed);
  graphProjectPathRef.current = projectPath;

  const loadGraphData = useCallback(
    async (reset = false) => {
      if (!projectPath || graphLoadingRef.current || (!reset && !graphHasMore)) return;
      const cursor = reset ? undefined : graphCommits[graphCommits.length - 1]?.oid;
      if (!reset && !cursor) return;

      graphLoadingRef.current = true;
      const requestId = ++graphLoadRequestRef.current;
      setGraphLoading(true);
      try {
        const page = await gitGraphHistory(
          projectPath,
          GRAPH_PAGE_SIZE,
          cursor,
          fileHistoryPath,
        );
        if (requestId !== graphLoadRequestRef.current) return;
        setGraphCommits((current) => {
          if (reset) return page;
          const knownOids = new Set(current.map((commit) => commit.oid));
          return [...current, ...page.filter((commit) => !knownOids.has(commit.oid))];
        });
        setGraphHasMore(page.length === GRAPH_PAGE_SIZE);
        setGraphInitialized(true);
        if (reset) {
          setSelectedCommit((current) =>
            current
              ? page.find((commit) => commit.oid === current.oid) ?? page[0] ?? null
              : fileHistoryPath ? page[0] ?? null : null
          );
        }
      } catch (error) {
        if (requestId !== graphLoadRequestRef.current) return;
        if (fileHistoryPath) {
          const detail = error instanceof Error ? error.message : String(error);
          message.error(`${t("sidebar.gitFileHistoryLoadFailed")}: ${detail}`);
        }
        if (reset) {
          setGraphCommits([]);
          setSelectedCommit(null);
          setGraphHasMore(false);
          setGraphInitialized(true);
        }
      } finally {
        if (requestId === graphLoadRequestRef.current) {
          graphLoadingRef.current = false;
          setGraphLoading(false);
        }
      }
    },
    [fileHistoryPath, graphCommits, graphHasMore, projectPath, t]
  );

  const loadCommitDetail = useCallback(
    async (commit: GitGraphCommit) => {
      if (!projectPath) return null;

      const cached = graphHoverDetailCacheRef.current.get(commit.oid);
      if (cached) {
        return cached;
      }

      const detail = await gitGraphCommitDetail(projectPath, commit.oid);
      graphHoverDetailCacheRef.current.set(commit.oid, detail);
      return detail;
    },
    [projectPath]
  );

  const resetAndLoadGraphData = useCallback(() => {
    graphHoverDetailCacheRef.current.clear();
    setSelectedCommitDetail(null);
    setSelectedCommitError(false);
    setGraphHasMore(true);
    void loadGraphData(true);
  }, [loadGraphData]);
  const fetchAndReloadGraph = useCallback(async () => {
    if (!projectPath || graphFetchingRef.current || graphLoadingRef.current) return;

    const fetchProjectPath = projectPath;
    graphFetchingRef.current = true;
    setGraphFetching(true);
    try {
      const result = await gitFetch(fetchProjectPath);
      if (graphProjectPathRef.current === fetchProjectPath && !result.success) {
        message.warning(`${t("sidebar.gitGraphFetchFailed")}: ${result.message}`);
      }
    } catch (error) {
      if (graphProjectPathRef.current === fetchProjectPath) {
        const detail = error instanceof Error ? error.message : String(error);
        message.warning(`${t("sidebar.gitGraphFetchFailed")}: ${detail}`);
      }
    } finally {
      if (graphProjectPathRef.current === fetchProjectPath) {
        graphFetchingRef.current = false;
        setGraphFetching(false);
        resetAndLoadGraphData();
      }
    }
  }, [projectPath, resetAndLoadGraphData, t]);

  useEffect(() => {
    if (graphVisible && !graphInitialized && !graphLoading) {
      void loadGraphData(true);
    }
  }, [graphInitialized, graphLoading, graphVisible, loadGraphData]);

  useEffect(() => {
    const wasCollapsed = previousCollapsedRef.current;
    previousCollapsedRef.current = collapsed;
    if (
      shouldReloadGitGraphOnExpand(wasCollapsed, collapsed, graphInitialized) &&
      !graphLoading
    ) {
      resetAndLoadGraphData();
    }
  }, [
    collapsed,
    graphInitialized,
    graphLoading,
    resetAndLoadGraphData,
  ]);

  useEffect(() => {
    const container = graphContainerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) {
          setGraphVisible(entry.isIntersecting);
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const sentinel = graphLoadMoreSentinelRef.current;
    if (!sentinel || collapsed || !graphInitialized || !graphHasMore || graphLoading) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadGraphData(false);
        }
      },
      { rootMargin: "240px 0px", threshold: 0 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [collapsed, graphHasMore, graphInitialized, graphLoading, loadGraphData]);

  useEffect(() => {
    const handleGraphRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ projectPath?: string }>).detail;
      if (!detail?.projectPath || detail.projectPath === projectPath) {
        resetAndLoadGraphData();
      }
    };

    window.addEventListener(GIT_GRAPH_REFRESH_EVENT, handleGraphRefresh as EventListener);
    return () => {
      window.removeEventListener(GIT_GRAPH_REFRESH_EVENT, handleGraphRefresh as EventListener);
    };
  }, [projectPath, resetAndLoadGraphData]);

  const clearGraphHoverCloseTimer = useCallback(() => {
    if (graphHoverCloseTimerRef.current !== null) {
      window.clearTimeout(graphHoverCloseTimerRef.current);
      graphHoverCloseTimerRef.current = null;
    }
  }, []);

  const closeGraphHoverCard = useCallback(() => {
    clearGraphHoverCloseTimer();
    graphHoverCardActiveRef.current = false;
    setGraphHover(null);
    setGraphHoverDetail(null);
    setGraphHoverLoading(false);
  }, [clearGraphHoverCloseTimer]);

  const scheduleGraphHoverClose = useCallback(() => {
    clearGraphHoverCloseTimer();
    graphHoverCloseTimerRef.current = window.setTimeout(() => {
      if (!graphHoverCardActiveRef.current) {
        setGraphHover(null);
        setGraphHoverDetail(null);
        setGraphHoverLoading(false);
      }
    }, 120);
  }, [clearGraphHoverCloseTimer]);

  const handleGraphCommitHover = useCallback(
    (commit: GitGraphCommit, rect: DOMRect) => {
      clearGraphHoverCloseTimer();
      setGraphHover({ commit, rect });
    },
    [clearGraphHoverCloseTimer]
  );

  const handleGraphCommitLeave = useCallback(() => {
    scheduleGraphHoverClose();
  }, [scheduleGraphHoverClose]);

  const handleGraphCommitSelect = useCallback((commit: GitGraphCommit) => {
    setSelectedGraphFileKey(null);
    setSelectedCommit((current) =>
      fileHistoryPath ? commit : current?.oid === commit.oid ? null : commit
    );
    closeGraphHoverCard();
  }, [closeGraphHoverCard, fileHistoryPath]);

  const buildGraphCommitMenu = useCallback(
    (commit: GitGraphCommit): MenuProps => ({
      items: [
        {
          key: "copy-revision",
          icon: <CopyOutlined />,
          label: t("sidebar.gitGraphCopyRevision"),
        },
      ],
      onClick: async ({ key }) => {
        if (key !== "copy-revision") return;

        try {
          await navigator.clipboard.writeText(commit.oid);
          message.success(t("sidebar.gitGraphCopyRevisionSuccess"));
        } catch {
          message.error(t("sidebar.gitGraphCopyRevisionFailed"));
        }
      },
    }),
    [t],
  );

  useEffect(() => {
    graphLoadRequestRef.current += 1;
    graphLoadingRef.current = false;
    setGraphLoading(false);
    graphHoverDetailCacheRef.current.clear();
    closeGraphHoverCard();
    setGraphCommits([]);
    setSelectedCommit(null);
    setSelectedCommitDetail(null);
    setSelectedCommitLoading(false);
    setSelectedCommitError(false);
    graphFetchingRef.current = false;
    setGraphFetching(false);
    setSelectedGraphFileKey(null);
    setOpeningGraphDiffKey(null);
    setGraphHasMore(true);
    setGraphInitialized(false);
  }, [projectPath, closeGraphHoverCard]);

  useEffect(() => {
    graphLoadRequestRef.current += 1;
    graphLoadingRef.current = false;
    setGraphLoading(false);
    graphHoverDetailCacheRef.current.clear();
    closeGraphHoverCard();
    setGraphCommits([]);
    setSelectedCommit(null);
    setSelectedCommitDetail(null);
    setSelectedCommitLoading(false);
    setSelectedCommitError(false);
    setSelectedGraphFileKey(null);
    setOpeningGraphDiffKey(null);
    setGraphHasMore(true);
    setGraphInitialized(false);
  }, [fileHistoryPath, closeGraphHoverCard]);

  useEffect(() => {
    if (!graphHover) return;

    let cancelled = false;
    setGraphHoverLoading(true);
    setGraphHoverDetail(null);

    loadCommitDetail(graphHover.commit)
      .then((detail) => {
        if (!cancelled) {
          setGraphHoverDetail(detail);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGraphHoverDetail(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setGraphHoverLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [graphHover, loadCommitDetail]);
  useEffect(() => {
    if (!selectedCommit) {
      setSelectedCommitDetail(null);
      setSelectedCommitLoading(false);
      setSelectedCommitError(false);
      return;
    }

    let cancelled = false;
    setSelectedCommitDetail(null);
    setSelectedCommitLoading(true);
    setSelectedCommitError(false);

    loadCommitDetail(selectedCommit)
      .then((detail) => {
        if (!cancelled) setSelectedCommitDetail(detail);
      })
      .catch(() => {
        if (!cancelled) setSelectedCommitError(true);
      })
      .finally(() => {
        if (!cancelled) setSelectedCommitLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [loadCommitDetail, selectedCommit]);

  useEffect(() => {
    if (!graphHover) return;

    const handleViewportChange = () => {
      if (!graphHoverCardActiveRef.current) {
        setGraphHover(null);
      }
    };

    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);

    return () => {
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [graphHover]);


  const handleGraphFileSelect = useCallback(
    async (commit: GitGraphCommit, file: GitGraphChangedFile) => {
      if (!projectPath) return;
      const fileKey = `${commit.oid}:${file.path}`;
      setSelectedGraphFileKey(fileKey);
      setOpeningGraphDiffKey(fileKey);
      try {
        const diffDocument = await gitGraphFileDiff(
          projectPath,
          commit.oid,
          file.path,
          file.oldPath,
        );
        const pathSegments = diffDocument.filePath.replace(/\\/g, "/").split("/");
        openGitDiffTab(
          {
            path: diffDocument.filePath,
            oldPath: file.oldPath,
            name: pathSegments[pathSegments.length - 1] ?? diffDocument.filePath,
            staged: false,
            revision: commit.oid,
            changeKind: file.status,
            hunkActionsAvailable: false,
            originalContent: diffDocument.originalContent,
            modifiedContent: diffDocument.modifiedContent,
            originalLabel: diffDocument.originalLabel,
            modifiedLabel: diffDocument.modifiedLabel,
            isBinary: diffDocument.isBinary,
          },
          { preview: true },
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        message.error(`${t("sidebar.gitGraphFileDiffFailed")}: ${detail}`);
      } finally {
        setOpeningGraphDiffKey((current) => current === fileKey ? null : current);
      }
    },
    [openGitDiffTab, projectPath, t],
  );

  const autoOpenedHistoryDiffRef = useRef<string | null>(null);
  useEffect(() => {
    if (!fileHistoryPath || !selectedCommit || !selectedCommitDetail) {
      autoOpenedHistoryDiffRef.current = null;
      return;
    }
    const normalize = (path: string | null | undefined) =>
      (path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
    const normalizedHistoryPath = normalize(fileHistoryPath);
    const file = selectedCommitDetail.files.find((item) =>
      normalize(item.path) === normalizedHistoryPath
      || normalize(item.oldPath) === normalizedHistoryPath
    );
    if (!file) return;

    const requestKey = `${selectedCommit.oid}:${file.path}`;
    if (autoOpenedHistoryDiffRef.current === requestKey) return;
    autoOpenedHistoryDiffRef.current = requestKey;
    void handleGraphFileSelect(selectedCommit, file);
  }, [fileHistoryPath, handleGraphFileSelect, selectedCommit, selectedCommitDetail]);
  const graphHoverCardStyle = useMemo(() => {
    if (!graphHover || typeof window === "undefined") {
      return null;
    }

    const left = Math.max(
      GRAPH_HOVER_CARD_MIN_TOP,
      Math.min(
        graphHover.rect.right + GRAPH_HOVER_CARD_OFFSET,
        window.innerWidth - GRAPH_HOVER_CARD_WIDTH - GRAPH_HOVER_CARD_MIN_TOP
      )
    );
    const top = Math.min(
      Math.max(graphHover.rect.top - 6, GRAPH_HOVER_CARD_MIN_TOP),
      window.innerHeight - GRAPH_HOVER_CARD_ESTIMATED_HEIGHT - GRAPH_HOVER_CARD_MIN_TOP
    );

    return {
      position: "fixed" as const,
      left,
      top,
      width: GRAPH_HOVER_CARD_WIDTH,
      zIndex: 1500,
    };
  }, [graphHover]);

  const renderedGraphCommits = useMemo(
    () => fileHistoryPath
      ? linearizeFileHistoryCommits(graphCommits)
      : graphCommits,
    [fileHistoryPath, graphCommits],
  );

  return (
    <div
      ref={graphContainerRef}
      className={`flex min-h-0 flex-col ${fileHistoryPath ? "flex-1" : ""}`}
      style={{ borderTop: "1px solid var(--cs-border-sidebar)" }}
    >
      <div className="flex items-center justify-between px-2" style={{ height: 22 }}>
        <button
          className="flex items-center gap-1.5 text-left text-[13px] font-semibold"
          style={{ color: "var(--cs-text-primary)" }}
          onClick={fileHistoryPath ? undefined : onToggleCollapse}
        >
          <DownOutlined className={`text-[9px] transition-transform ${collapsed ? "-rotate-90" : ""}`} />
          <span>{fileHistoryPath ? t("sidebar.gitFileHistoryPanel") : sectionTitle}</span>
        </button>
        <div className="flex items-center gap-1">
          <Tooltip title={refreshText} mouseEnterDelay={0.4}>
            <Button
              type="text"
              size="small"
              icon={graphLoading || graphFetching ? <LoadingOutlined /> : <ReloadOutlined />}
              style={{
                width: 24,
                height: 24,
                padding: 0,
                color: "var(--cs-text-secondary)",
              }}
              onClick={() => void fetchAndReloadGraph()}
              disabled={graphLoading || graphFetching}
            />
          </Tooltip>
        </div>
      </div>

      {fileHistoryPath ? (
        <div
          className="mx-2 mb-1.5 flex min-w-0 items-center gap-1.5 rounded px-2 py-1.5 text-[11px]"
          style={{
            background: "color-mix(in srgb, var(--cs-primary) 10%, transparent)",
            color: "var(--cs-text-secondary)",
          }}
          title={fileHistoryPath}
        >
          <HistoryOutlined className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{fileHistoryPath}</span>
          <Tooltip title={t("sidebar.gitFileHistoryClear")} mouseEnterDelay={0.4}>
            <Button
              type="text"
              size="small"
              icon={<CloseOutlined />}
              aria-label={t("sidebar.gitFileHistoryClear")}
              onClick={onClearFileHistory}
              style={{ width: 20, height: 20, minWidth: 20, padding: 0 }}
            />
          </Tooltip>
        </div>
      ) : null}

      {!collapsed && (
        graphLoading && graphCommits.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6" style={{ color: "var(--cs-text-tertiary)" }}>
            <LoadingOutlined />
            <span className="text-xs">加载提交历史...</span>
          </div>
        ) : graphCommits.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8" style={{ color: "var(--cs-text-tertiary)" }}>
            <BranchesOutlined className="text-2xl" />
            <span className="text-sm">
              {fileHistoryPath ? t("sidebar.gitFileHistoryPlaceholder") : placeholderText}
            </span>
          </div>
        ) : (
          <>
            <GitGraphRenderer
              commits={renderedGraphCommits}
              selectedCommitOid={selectedCommit?.oid ?? null}
              expandedCommitOid={fileHistoryPath ? null : selectedCommit?.oid ?? null}
              expandedFiles={selectedCommitDetail?.files ?? []}
              expandedFilesLoading={selectedCommitLoading}
              expandedFilesError={selectedCommitError}
              selectedFileKey={selectedGraphFileKey}
              openingFileKey={openingGraphDiffKey}
              onFileSelect={handleGraphFileSelect}
              onCommitSelect={handleGraphCommitSelect}
              buildCommitMenu={buildGraphCommitMenu}
              onCommitHover={handleGraphCommitHover}
              onCommitLeave={handleGraphCommitLeave}
            />

            <div
              ref={graphLoadMoreSentinelRef}
              className={`flex items-center justify-center border-t px-2 ${graphLoading || !graphHasMore ? "h-8" : "h-px"}`}
              style={{
                borderColor: "var(--cs-border-sidebar)",
                color: "var(--cs-text-tertiary)",
              }}
              aria-live="polite"
            >
              {graphLoading ? (
                <span className="flex items-center gap-1.5 text-[11px]">
                  <LoadingOutlined />
                  {t("sidebar.gitGraphLoadingMore")}
                </span>
              ) : !graphHasMore ? (
                <span className="text-[11px]">
                  {t("sidebar.gitGraphAllLoaded", { count: graphCommits.length })}
                </span>
              ) : null}
            </div>

          </>
        )
      )}

      {graphHover && graphHoverCardStyle && typeof document !== "undefined"
        ? createPortal(
            <div
              role="tooltip"
              className="app-git-graph-hover-card pointer-events-auto"
              style={graphHoverCardStyle}
              onMouseEnter={() => {
                graphHoverCardActiveRef.current = true;
                clearGraphHoverCloseTimer();
              }}
              onMouseLeave={() => {
                graphHoverCardActiveRef.current = false;
                scheduleGraphHoverClose();
              }}
            >
              <div className="flex min-w-0 flex-col text-[12px] leading-[18px]">
                <div
                  className="flex min-w-0 items-center gap-1.5"
                  style={{ color: "var(--cs-text-secondary)" }}
                >
                  <UserOutlined className="shrink-0" />
                  <span className="min-w-0 truncate font-semibold" style={{ color: "var(--cs-text-primary)" }}>
                    {graphHover.commit.authorName}
                  </span>
                  <span aria-hidden="true">,</span>
                  <HistoryOutlined className="shrink-0" />
                  <span className="min-w-0 truncate">
                    {formatGraphCommitRelativeTime(
                      graphHover.commit.timestampMs,
                      i18n.resolvedLanguage ?? i18n.language
                    )}
                    {" ("}
                    {formatGraphCommitTime(
                      graphHover.commit.timestampMs,
                      i18n.resolvedLanguage ?? i18n.language
                    )}
                    {")"}
                  </span>
                </div>

                <div className="app-git-graph-hover-separator" />

                <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words app-project-tree-scroll">
                  <div className="font-medium" style={{ color: "var(--cs-text-primary)" }}>
                    {graphHover.commit.summary}
                  </div>
                  {!graphHoverLoading && graphHoverDetail?.body?.trim() ? (
                    <div className="mt-1" style={{ color: "var(--cs-text-secondary)" }}>
                      {graphHoverDetail.body.trim()}
                    </div>
                  ) : null}
                </div>

                <div className="app-git-graph-hover-separator" />
                <CommitStats detail={graphHoverDetail} loading={graphHoverLoading} />

                {graphHover.commit.refs.length > 0 ? (() => {
                  const { regular, worktrees } = splitWorktreeReferences(graphHover.commit.refs);
                  return (
                  <>
                    <div className="app-git-graph-hover-separator" />
                    {regular.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-1">
                      {regular.map((ref) => {
                        const badge = getGraphRefBadgeStyles(ref.kind);
                        return (
                          <span
                            key={`${graphHover.commit.oid}:${ref.kind}:${ref.name}`}
                            className="inline-flex max-w-[132px] items-center truncate rounded-full px-2 py-0.5 text-[10px] font-semibold leading-[14px]"
                            style={badge}
                          >
                            {ref.name}
                          </span>
                        );
                      })}
                      </div>
                    ) : null}
                    {worktrees.length > 0 ? (
                      <details className={regular.length > 0 ? "mt-2" : ""}>
                        <summary
                          className="cursor-pointer select-none text-[11px] font-medium"
                          style={{ color: "var(--cs-text-secondary)" }}
                        >
                          worktrees {worktrees.length}
                        </summary>
                        <div className="mt-1.5 flex max-h-24 flex-wrap items-center gap-1 overflow-y-auto pr-1 app-project-tree-scroll">
                          {worktrees.map((ref) => {
                            const badge = getGraphRefBadgeStyles(ref.kind);
                            return (
                              <span
                                key={`${graphHover.commit.oid}:${ref.kind}:${ref.name}`}
                                title={ref.name}
                                className="inline-flex max-w-[132px] items-center truncate rounded-full px-2 py-0.5 text-[10px] font-semibold leading-[14px]"
                                style={badge}
                              >
                                {ref.name}
                              </span>
                            );
                          })}
                        </div>
                      </details>
                    ) : null}
                  </>
                  );
                })() : null}

                <div className="app-git-graph-hover-separator" />
                <div className="font-mono text-[10px]" style={{ color: "var(--cs-text-tertiary)" }}>
                  {graphHover.commit.shortOid}
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
