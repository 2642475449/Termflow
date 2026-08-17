import { CloseOutlined, DatabaseOutlined, LoadingOutlined, ReloadOutlined, WarningOutlined } from "@ant-design/icons";
import { listen } from "@tauri-apps/api/event";
import { message, Popover } from "antd";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentIcon } from "@/components/AgentIcon";
import { getClaudeRateLimits, getCodexRateLimits, getSearchIndexStatus, gitCancelCloneTask, inspectAgentClis } from "@/lib/api";
import { summarizeBackgroundTasks } from "@/lib/backgroundTasks";
import {
  shouldLoadClaudeRateLimits,
  shouldLoadCodexRateLimits,
  shouldShowClaudeRateLimits,
} from "@/lib/codexUsage";
import { formatAgentVersion, getAgentDisplayName, isAiAgentId } from "@/lib/agents";
import { useProjectLauncher } from "@/hooks/useProjectLauncher";
import { useAppStore } from "@/store";
import type { AiAgentId, ClaudeRateLimits, ClaudeRateLimitsUpdatePayload, CodexRateLimits, CodexRateLimitWindow, GitCloneEventPayload, GitCloneTask, ProjectSearchIndexStatus } from "@/types";
const GIT_CLONE_EVENT = "git-clone-task-event";
const SEARCH_INDEX_EVENT = "search-index-status";

function normalizeProjectPath(value: string): string {
  return value.replaceAll("\\", "/").toLocaleLowerCase();
}

function StatusBar() {
  const { t } = useTranslation();
  const { openProject } = useProjectLauncher();
  const sessions = useAppStore((state) => state.sessions);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const defaultAgentId = useAppStore((state) => state.defaultAgentId);
  const claudeCliInfo = useAppStore((state) => state.claudeCliInfo);
  const currentProject = useAppStore((state) => state.currentProject);
  const gitCloneTasks = useAppStore((state) => state.gitCloneTasks);
  const upsertGitCloneTask = useAppStore((state) => state.upsertGitCloneTask);
  const removeGitCloneTask = useAppStore((state) => state.removeGitCloneTask);
  const [agentVersion, setAgentVersion] = useState<string | null>(null);
  const [codexRateLimits, setCodexRateLimits] = useState<CodexRateLimits | null>(null);
  const [codexUsageLoading, setCodexUsageLoading] = useState(false);
  const [codexUsageError, setCodexUsageError] = useState<string | null>(null);
  const [claudeRateLimits, setClaudeRateLimits] = useState<ClaudeRateLimits | null>(null);
  const [claudeUsageLoading, setClaudeUsageLoading] = useState(false);
  const [claudeUsageError, setClaudeUsageError] = useState<string | null>(null);
  const [cancellingTaskIds, setCancellingTaskIds] = useState<string[]>([]);
  const [searchIndexStatus, setSearchIndexStatus] = useState<ProjectSearchIndexStatus | null>(null);
  const [searchIndexStatusProjectPath, setSearchIndexStatusProjectPath] = useState<string | null>(null);
  const [searchIndexStatusError, setSearchIndexStatusError] = useState<string | null>(null);
  const [searchIndexListenerError, setSearchIndexListenerError] = useState<string | null>(null);
  const visibleSearchIndexStatus = currentProject?.path
    && searchIndexStatusProjectPath
    && normalizeProjectPath(currentProject.path) === normalizeProjectPath(searchIndexStatusProjectPath)
    ? searchIndexStatus
    : null;
  const visibleSearchIndexStatusError = currentProject?.path
    && searchIndexStatusProjectPath
    && normalizeProjectPath(currentProject.path) === normalizeProjectPath(searchIndexStatusProjectPath)
    ? searchIndexListenerError ?? searchIndexStatusError
    : null;

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const showCodexUsage = shouldLoadCodexRateLimits(activeSession);
  const loadClaudeUsage = shouldLoadClaudeRateLimits(activeSession);
  const showClaudeUsage = loadClaudeUsage && shouldShowClaudeRateLimits(claudeRateLimits);
  const effectiveAgentId = useMemo<AiAgentId | null>(() => {
    if (isAiAgentId(activeSession?.agentId)) {
      return activeSession.agentId;
    }
    return defaultAgentId;
  }, [activeSession?.agentId, defaultAgentId]);

  useEffect(() => {
    if (!effectiveAgentId) {
      setAgentVersion(null);
      return;
    }

    let disposed = false;
    const cachedClaudeVersion = effectiveAgentId === "claude" ? claudeCliInfo?.version ?? null : null;
    setAgentVersion(cachedClaudeVersion);

    void inspectAgentClis()
      .then((agents) => {
        if (disposed) return;
        const currentAgent = agents.find((agent) => agent.id === effectiveAgentId && agent.installed) ?? null;
        const currentVersion = currentAgent?.version ?? cachedClaudeVersion;
        setAgentVersion(currentVersion);

        if (!currentVersion) {
          void inspectAgentClis({ forceRefresh: true })
            .then((freshAgents) => {
              if (disposed) return;
              const freshAgent = freshAgents.find((agent) => agent.id === effectiveAgentId && agent.installed) ?? null;
              setAgentVersion(freshAgent?.version ?? cachedClaudeVersion);
            })
            .catch((error) => {
              console.error("Failed to refresh agent version for status bar:", error);
            });
        }
      })
      .catch((error) => {
        console.error("Failed to inspect agents for status bar:", error);
        if (!disposed) {
          setAgentVersion(cachedClaudeVersion);
        }
      });

    return () => {
      disposed = true;
    };
  }, [claudeCliInfo?.version, effectiveAgentId]);

  useEffect(() => {
    if (!showCodexUsage) {
      setCodexRateLimits(null);
      setCodexUsageError(null);
      setCodexUsageLoading(false);
      return;
    }

    let disposed = false;

    const loadCodexUsage = async (forceRefresh = false) => {
      setCodexUsageLoading(true);
      try {
        const limits = await getCodexRateLimits({ forceRefresh });
        if (disposed) return;
        setCodexRateLimits(limits);
        setCodexUsageError(null);
      } catch (error) {
        if (disposed) return;
        setCodexUsageError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!disposed) {
          setCodexUsageLoading(false);
        }
      }
    };

    void loadCodexUsage(false);
    const interval = window.setInterval(() => {
      void loadCodexUsage(true);
    }, 3 * 60 * 1000);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [showCodexUsage]);

  useEffect(() => {
    const sessionId = loadClaudeUsage ? activeSession?.id : null;
    if (!sessionId) {
      setClaudeRateLimits(null);
      setClaudeUsageError(null);
      setClaudeUsageLoading(false);
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;
    const fetchClaudeUsage = async () => {
      setClaudeUsageLoading(true);
      try {
        const limits = await getClaudeRateLimits(sessionId);
        if (disposed) return;
        setClaudeRateLimits(limits);
        setClaudeUsageError(null);
      } catch (error) {
        if (disposed) return;
        setClaudeUsageError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!disposed) setClaudeUsageLoading(false);
      }
    };

    void fetchClaudeUsage();
    void listen<ClaudeRateLimitsUpdatePayload>("claude-rate-limits-update", (event) => {
      if (disposed || event.payload.sessionId !== sessionId) return;
      const { sessionId: _sessionId, ...limits } = event.payload;
      setClaudeRateLimits(limits);
      setClaudeUsageError(null);
      setClaudeUsageLoading(false);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [activeSession?.id, loadClaudeUsage]);

  const handleRefreshCodexUsage = () => {
    setCodexUsageLoading(true);
    getCodexRateLimits({ forceRefresh: true })
      .then((limits) => {
        setCodexRateLimits(limits);
        setCodexUsageError(null);
      })
      .catch((error) => {
        setCodexUsageError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setCodexUsageLoading(false);
      });
  };

  const handleRefreshClaudeUsage = () => {
    if (!activeSession?.id) return;
    setClaudeUsageLoading(true);
    getClaudeRateLimits(activeSession.id)
      .then((limits) => {
        setClaudeRateLimits(limits);
        setClaudeUsageError(null);
      })
      .catch((error) => {
        setClaudeUsageError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setClaudeUsageLoading(false));
  };

  useEffect(() => {
    const projectPath = currentProject?.path ?? null;
    setSearchIndexStatus(null);
    setSearchIndexStatusProjectPath(null);
    setSearchIndexStatusError(null);
    setSearchIndexListenerError(null);
    if (!projectPath) return;

    let disposed = false;
    let cleanup: (() => void) | undefined;

    void listen<ProjectSearchIndexStatus>(SEARCH_INDEX_EVENT, (event) => {
      if (disposed) return;
      if (normalizeProjectPath(event.payload.projectPath) !== normalizeProjectPath(projectPath)) return;
      setSearchIndexStatus(event.payload);
      setSearchIndexStatusProjectPath(projectPath);
      setSearchIndexStatusError(null);
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else {
          cleanup = unlisten;
          setSearchIndexListenerError(null);
        }
      })
      .catch((error) => {
        if (disposed) return;
        const detail = error instanceof Error ? error.message : String(error);
        console.error("Failed to listen for search index progress:", error);
        setSearchIndexStatusProjectPath(projectPath);
        setSearchIndexListenerError(detail);
      });

    void getSearchIndexStatus(projectPath)
      .then((status) => {
        if (disposed) return;
        setSearchIndexStatus(status);
        setSearchIndexStatusProjectPath(projectPath);
        setSearchIndexStatusError(null);
      })
      .catch((error) => {
        if (disposed) return;
        const detail = error instanceof Error ? error.message : String(error);
        console.error("Failed to load search index progress:", error);
        setSearchIndexStatusProjectPath(projectPath);
        setSearchIndexStatusError(detail);
      });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [currentProject?.path]);

  const indexNeedsPolling = visibleSearchIndexStatus?.enabled === true
    && ["preflight", "building", "stale"].includes(visibleSearchIndexStatus.state);

  useEffect(() => {
    const projectPath = currentProject?.path ?? null;
    if (!projectPath || !indexNeedsPolling) return;
    let disposed = false;
    const timer = window.setInterval(() => {
      void getSearchIndexStatus(projectPath)
        .then((status) => {
          if (disposed) return;
          setSearchIndexStatus(status);
          setSearchIndexStatusProjectPath(projectPath);
          setSearchIndexStatusError(null);
        })
        .catch((error) => {
          if (disposed) return;
          setSearchIndexStatusProjectPath(projectPath);
          setSearchIndexStatusError(error instanceof Error ? error.message : String(error));
        });
    }, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [currentProject?.path, indexNeedsPolling]);

  const agentDisplayName = effectiveAgentId ? getAgentDisplayName(effectiveAgentId) : "";
  const versionLabel = effectiveAgentId && agentVersion
    ? `${agentDisplayName} ${formatAgentVersion(agentVersion, agentDisplayName)}`
    : effectiveAgentId
      ? agentDisplayName
      : "";
  const cloneTasks = [...gitCloneTasks].reverse();
  const activeCloneTask = cloneTasks[0] ?? null;
  const backgroundTaskSummary = summarizeBackgroundTasks(
    cloneTasks,
    visibleSearchIndexStatus,
    visibleSearchIndexStatusError,
  );
  const additionalBackgroundTaskCount = Math.max(backgroundTaskSummary.totalCount - 1, 0);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;

    void listen<GitCloneEventPayload>(GIT_CLONE_EVENT, async (event) => {
      const payload = event.payload;
      const nextTask: GitCloneTask = {
        taskId: payload.taskId,
        status: payload.status,
        projectPath: payload.projectPath,
        directoryName: payload.directoryName,
        remoteUrl: payload.remoteUrl,
        stage: payload.stage ?? null,
        progressPercent: payload.progressPercent ?? null,
        current: payload.current ?? null,
        total: payload.total ?? null,
        transferred: payload.transferred ?? null,
        speed: payload.speed ?? null,
        detail: payload.detail ?? null,
        error: payload.error ?? null,
      };

      upsertGitCloneTask(nextTask);

      if (disposed) {
        return;
      }

      if (payload.status === "completed") {
        try {
          await openProject(payload.projectPath);
        } catch (error) {
          console.error("Failed to open cloned project window:", error);
          message.error(t("sidebar.projectWindowOpenFailed"));
        } finally {
          removeGitCloneTask(payload.taskId);
        }
        return;
      }

      if (payload.status === "failed") {
        message.error(payload.error || t("projectLauncher.cloneFailed"));
        removeGitCloneTask(payload.taskId);
        setCancellingTaskIds((current) => current.filter((item) => item !== payload.taskId));
      }

      if (payload.status === "cancelled") {
        removeGitCloneTask(payload.taskId);
        setCancellingTaskIds((current) => current.filter((item) => item !== payload.taskId));
      }
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        cleanup = unlisten;
      })
      .catch((error) => {
        console.error("Failed to listen for clone progress:", error);
      });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [openProject, removeGitCloneTask, upsertGitCloneTask]);

  const cloneStageLabel = activeCloneTask?.stage
    ? t(`projectLauncher.cloneStages.${activeCloneTask.stage}`, {
        defaultValue: activeCloneTask.stage,
      })
    : t("projectLauncher.cloning");
  const cloneCountLabel = activeCloneTask?.current && activeCloneTask?.total
    ? `${activeCloneTask.current}/${activeCloneTask.total}`
    : activeCloneTask?.total
      ? `${activeCloneTask.total}`
      : null;
  const cloneMetaLabel = [
    activeCloneTask?.progressPercent != null ? `${activeCloneTask.progressPercent}%` : null,
    cloneCountLabel,
    activeCloneTask?.transferred,
    activeCloneTask?.speed,
    simplifyRemoteUrl(activeCloneTask?.remoteUrl ?? null),
  ].filter(Boolean).join(" · ");
  const indexStateLabel = visibleSearchIndexStatusError
    ? t("statusBar.backgroundTasks.unavailable")
    : t(`statusBar.backgroundTasks.${visibleSearchIndexStatus?.state ?? "unavailable"}`, {
        defaultValue: visibleSearchIndexStatus?.state ?? "unavailable",
      });
  const indexMetaLabel = visibleSearchIndexStatusError
    ? visibleSearchIndexStatusError
    : visibleSearchIndexStatus?.totalFiles != null
      ? t("statusBar.backgroundTasks.files", {
          processed: visibleSearchIndexStatus.processedFiles,
          total: visibleSearchIndexStatus.totalFiles,
        })
      : visibleSearchIndexStatus
        ? t("statusBar.backgroundTasks.discoveredFiles", {
            count: visibleSearchIndexStatus.processedFiles,
          })
        : t("statusBar.backgroundTasks.unavailable");
  const cloneCompactProgress = activeCloneTask?.progressPercent != null
    ? `${activeCloneTask.progressPercent}%`
    : t("statusBar.backgroundTasks.pending");
  const indexCompactProgress = backgroundTaskSummary.indexProgressPercent != null
    ? `${backgroundTaskSummary.indexProgressPercent}%`
    : indexStateLabel;
  const compactTaskMeta = backgroundTaskSummary.concurrent
    ? [
        `${t("statusBar.backgroundTasks.cloneCompact")} ${cloneCompactProgress}`,
        `${t("statusBar.backgroundTasks.indexCompact")} ${indexCompactProgress}`,
      ].join(" · ")
    : activeCloneTask
      ? cloneMetaLabel
      : indexCompactProgress;
  const indexHasError = Boolean(visibleSearchIndexStatusError)
    || visibleSearchIndexStatus?.state === "failed"
    || visibleSearchIndexStatus?.state === "unsupported";
  const compactTaskTitle = backgroundTaskSummary.concurrent
    ? t("statusBar.backgroundTasks.multiple", { count: backgroundTaskSummary.totalCount })
    : activeCloneTask
      ? t("projectLauncher.backgroundCloning", { name: activeCloneTask.directoryName })
      : t("statusBar.backgroundTasks.indexing", {
          name: currentProject?.name ?? t("statusBar.backgroundTasks.searchIndex"),
        });
  const compactTaskStage = backgroundTaskSummary.concurrent
    ? null
    : activeCloneTask
      ? cloneStageLabel
      : indexStateLabel;
  const backgroundTaskPopoverContent = backgroundTaskSummary.totalCount > 0 ? (
    <div
      className="w-[520px] overflow-hidden rounded-[12px] border"
      style={{
        background: "var(--cs-bg-elevated, var(--cs-bg-sidebar))",
        borderColor: "var(--cs-border-sidebar)",
        boxShadow: "0 24px 56px rgba(0, 0, 0, 0.36)",
      }}
    >
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: "1px solid color-mix(in srgb, var(--cs-border-sidebar) 82%, transparent)" }}
      >
        <span className="text-[12px] font-medium" style={{ color: "var(--cs-text-primary)" }}>
          {t("statusBar.backgroundTasks.title")}
        </span>
        <span className="text-[11px]" style={{ color: "var(--cs-text-tertiary)" }}>
          {t("statusBar.backgroundTasks.count", { count: backgroundTaskSummary.totalCount })}
        </span>
      </div>
      <div className="max-h-[420px] overflow-y-auto px-3 py-2">
        {backgroundTaskSummary.indexVisible ? (
          <div className="px-1 py-3">
            <div className="flex items-center gap-2">
              {indexHasError ? (
                <WarningOutlined style={{ color: "var(--cs-warning, #d89614)", fontSize: 11 }} />
              ) : (
                <DatabaseOutlined style={{ color: "var(--cs-primary)", fontSize: 11 }} />
              )}
              <span
                className="min-w-0 flex-1 truncate text-[13px] font-medium"
                style={{ color: "var(--cs-text-primary)" }}
                title={currentProject?.path}
              >
                {t("statusBar.backgroundTasks.indexing", {
                  name: currentProject?.name ?? t("statusBar.backgroundTasks.searchIndex"),
                })}
              </span>
              <span className="shrink-0 text-[10px]" style={{ color: "var(--cs-text-tertiary)" }}>
                {indexStateLabel}
              </span>
            </div>
            {!indexHasError ? (
              <div
                className="mt-2 h-[3px] overflow-hidden rounded-full"
                style={{ background: "color-mix(in srgb, var(--cs-border) 72%, transparent)" }}
              >
                <div
                  className="h-full rounded-full transition-[width] duration-150"
                  style={{
                    width: `${Math.max(backgroundTaskSummary.indexProgressPercent ?? 8, 8)}%`,
                    background: "var(--cs-primary)",
                  }}
                />
              </div>
            ) : null}
            <div
              className="mt-2 truncate text-[11px]"
              style={{ color: indexHasError ? "var(--cs-warning, #d89614)" : "var(--cs-text-tertiary)" }}
              title={indexMetaLabel}
            >
              {indexMetaLabel}
            </div>
            {currentProject?.path ? (
              <div
                className="mt-1 truncate text-[11px]"
                style={{ color: "var(--cs-text-quaternary, var(--cs-text-tertiary))" }}
                title={currentProject.path}
              >
                {currentProject.path}
              </div>
            ) : null}
          </div>
        ) : null}
        {cloneTasks.map((task, index) => {
          const taskStageLabel = task.stage
            ? t(`projectLauncher.cloneStages.${task.stage}`, { defaultValue: task.stage })
            : t("projectLauncher.cloning");
          const taskMetaLabel = [
            task.progressPercent != null ? `${task.progressPercent}%` : null,
            task.current != null && task.total != null ? `${task.current}/${task.total}` : null,
            task.transferred,
            task.speed,
          ].filter(Boolean).join(" · ");
          const taskSource = simplifyRemoteUrl(task.remoteUrl) || task.projectPath;

          return (
            <div
              key={task.taskId}
              className="px-1 py-3"
              style={{
                borderTop: index === 0 && !backgroundTaskSummary.indexVisible
                  ? "none"
                  : "1px solid color-mix(in srgb, var(--cs-border-sidebar) 72%, transparent)",
              }}
            >
              <div className="flex items-center gap-2">
                <LoadingOutlined style={{ color: "var(--cs-primary)", fontSize: 11 }} />
                <span
                  className="min-w-0 flex-1 truncate text-[13px] font-medium"
                  style={{ color: "var(--cs-text-primary)" }}
                  title={task.directoryName}
                >
                  {task.directoryName}
                </span>
                <span className="shrink-0 text-[10px]" style={{ color: "var(--cs-text-tertiary)" }}>
                  {taskStageLabel}
                </span>
                <button
                  type="button"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] transition-colors"
                  style={{
                    color: "var(--cs-text-tertiary)",
                    background: "transparent",
                    border: "0",
                    opacity: cancellingTaskIds.includes(task.taskId) ? 0.45 : 1,
                    cursor: cancellingTaskIds.includes(task.taskId) ? "wait" : "pointer",
                  }}
                  disabled={cancellingTaskIds.includes(task.taskId)}
                  title={t("projectLauncher.cancelTask")}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setCancellingTaskIds((current) =>
                      current.includes(task.taskId) ? current : [...current, task.taskId]
                    );
                    void gitCancelCloneTask(task.taskId).catch((error) => {
                      setCancellingTaskIds((current) => current.filter((item) => item !== task.taskId));
                      message.error(error instanceof Error ? error.message : String(error));
                    });
                  }}
                >
                  <CloseOutlined style={{ fontSize: 10 }} />
                </button>
              </div>
              <div
                className="mt-2 h-[3px] overflow-hidden rounded-full"
                style={{ background: "color-mix(in srgb, var(--cs-border) 72%, transparent)" }}
              >
                <div
                  className="h-full rounded-full transition-[width] duration-150"
                  style={{
                    width: `${Math.max(task.progressPercent ?? 8, 8)}%`,
                    background: "var(--cs-primary)",
                  }}
                />
              </div>
              <div className="mt-2 flex items-center gap-2 text-[11px]" style={{ color: "var(--cs-text-tertiary)" }}>
                <span className="truncate">{taskMetaLabel || t("projectLauncher.cloning")}</span>
              </div>
              <div
                className="mt-1 truncate text-[11px]"
                style={{ color: "var(--cs-text-quaternary, var(--cs-text-tertiary))" }}
                title={taskSource}
              >
                {t("projectLauncher.cloneSource")}: {taskSource}
              </div>
            </div>
          );
        })}
      </div>
      {backgroundTaskSummary.concurrent ? (
        <div
          className="px-3 py-2 text-[11px]"
          style={{
            color: "var(--cs-text-tertiary)",
            borderTop: "1px solid color-mix(in srgb, var(--cs-border-sidebar) 72%, transparent)",
          }}
        >
          {t("statusBar.backgroundTasks.concurrentHint")}
        </div>
      ) : null}
    </div>
  ) : null;

  return (
    <div
      className="app-shell-chrome app-statusbar h-8 px-3 flex items-center justify-between gap-3 text-[12px]"
      style={{
        background: "transparent",
        borderTop: "0",
        color: "var(--cs-text-tertiary)",
      }}
    >
      <div className="flex min-w-0 flex-1 items-center justify-start">
        {showCodexUsage ? (
          <RateLimitUsageStatus
            agentId="codex"
            limits={codexRateLimits}
            isLoading={codexUsageLoading}
            error={codexUsageError}
            onRefresh={handleRefreshCodexUsage}
          />
        ) : showClaudeUsage ? (
          <RateLimitUsageStatus
            agentId="claude"
            limits={claudeRateLimits}
            isLoading={claudeUsageLoading}
            error={claudeUsageError}
            onRefresh={handleRefreshClaudeUsage}
          />
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
        {backgroundTaskSummary.totalCount > 0 ? (
          <Popover
            trigger={["click"]}
            placement="topRight"
            content={backgroundTaskPopoverContent}
            arrow={false}
            overlayInnerStyle={{ padding: 0, background: "transparent", boxShadow: "none" }}
            styles={{ body: { padding: 0 } }}
            getPopupContainer={() => document.body}
          >
            <button
              type="button"
              className="flex h-6 min-w-0 items-center gap-2 px-0 text-left transition-colors"
              style={{
                width: "min(360px, 45vw)",
                background: "transparent",
                border: "0",
                boxShadow: "none",
              }}
              title={backgroundTaskSummary.concurrent
                ? t("statusBar.backgroundTasks.concurrentHint")
                : activeCloneTask?.remoteUrl || activeCloneTask?.projectPath || currentProject?.path}
            >
              {indexHasError && !activeCloneTask ? (
                <WarningOutlined style={{ color: "var(--cs-warning, #d89614)", fontSize: 11 }} />
              ) : backgroundTaskSummary.indexVisible && !activeCloneTask ? (
                <DatabaseOutlined style={{ color: "var(--cs-primary)", fontSize: 11 }} />
              ) : (
                <LoadingOutlined style={{ color: "var(--cs-primary)", fontSize: 11 }} />
              )}
              <div className="flex min-w-0 flex-1 flex-col justify-center">
                <div className="flex min-w-0 items-center gap-2 leading-none">
                  <span className="truncate" style={{ color: "var(--cs-text-secondary)" }}>
                    {compactTaskTitle}
                  </span>
                  {compactTaskStage ? (
                    <span className="shrink-0" style={{ color: "var(--cs-text-tertiary)" }}>
                      {compactTaskStage}
                    </span>
                  ) : null}
                </div>
                <div
                  className="mt-1 flex h-[2px] gap-[2px] overflow-hidden rounded-full"
                >
                  {activeCloneTask ? (
                    <div
                      className="h-full flex-1 overflow-hidden rounded-full"
                      style={{ background: "color-mix(in srgb, var(--cs-border) 48%, transparent)" }}
                    >
                      <div
                        className="h-full rounded-full transition-[width] duration-150"
                        style={{
                          width: `${Math.max(activeCloneTask.progressPercent ?? 8, 8)}%`,
                          background: "var(--cs-primary)",
                        }}
                      />
                    </div>
                  ) : null}
                  {backgroundTaskSummary.indexVisible ? (
                    <div
                      className="h-full flex-1 overflow-hidden rounded-full"
                      style={{ background: "color-mix(in srgb, var(--cs-border) 48%, transparent)" }}
                    >
                      <div
                        className="h-full rounded-full transition-[width] duration-150"
                        style={{
                          width: `${indexHasError ? 100 : Math.max(backgroundTaskSummary.indexProgressPercent ?? 8, 8)}%`,
                          background: indexHasError ? "var(--cs-warning, #d89614)" : "var(--cs-primary)",
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="max-w-[96px] truncate text-[10px] leading-none"
                  style={{ color: "var(--cs-text-tertiary)" }}
                >
                  {compactTaskMeta}
                </span>
                {additionalBackgroundTaskCount > 0 ? (
                  <span
                    className="shrink-0 text-[10px] font-medium"
                    style={{
                      color: "var(--cs-text-secondary)",
                    }}
                  >
                    +{additionalBackgroundTaskCount}
                  </span>
                ) : null}
              </div>
            </button>
          </Popover>
        ) : null}
        <span
          className="min-w-0 max-w-[360px] truncate text-[12px]"
          title={versionLabel}
        >
          {versionLabel}
        </span>
      </div>
    </div>
  );
}

function RateLimitUsageStatus({
  agentId,
  limits,
  isLoading,
  error,
  onRefresh,
}: {
  agentId: "claude" | "codex";
  limits: ClaudeRateLimits | CodexRateLimits | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const translationRoot = agentId === "claude" ? "statusBar.claudeUsage" : "statusBar.codexUsage";
  const codexLimits = agentId === "codex" ? limits as CodexRateLimits | null : null;
  const hasData = Boolean(limits?.session || limits?.weekly);
  const statusError = error
    ?? limits?.error
    ?? (limits?.status === "unavailable" ? t(`${translationRoot}.unavailable`) : null);
  const summary = formatRateLimitUsageSummary(limits, isLoading, statusError, t, translationRoot);
  const resetCredits = codexLimits?.rateLimitResetCredits?.availableCount;
  // Keep the compact progress bar in sync with the first window shown in the
  // summary. Some Codex accounts only return a weekly limit, so reading the
  // session window alone incorrectly rendered a 0% gray bar next to "99% 周".
  const compactWindow = limits?.session ?? limits?.weekly ?? null;
  const compactRemaining = compactWindow ? remainingPercent(compactWindow) : null;
  const compactBarColor = compactRemaining == null
    ? "var(--cs-text-tertiary)"
    : codexUsageBarColor(compactRemaining);

  const popoverContent = (
    <div
      className="w-[286px] overflow-hidden rounded-[8px] border"
      style={{
        background: "var(--cs-bg-elevated, var(--cs-bg-sidebar))",
        borderColor: "var(--cs-border-sidebar)",
        boxShadow: "0 18px 44px rgba(0, 0, 0, 0.30)",
      }}
    >
      <div
        className="flex items-center justify-between gap-3 px-3 py-2"
        style={{ borderBottom: "1px solid color-mix(in srgb, var(--cs-border-sidebar) 82%, transparent)" }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <AgentIcon agentId={agentId} size={15} />
          <div className="min-w-0">
            <div className="truncate text-[12px] font-medium" style={{ color: "var(--cs-text-primary)" }}>
              {t(`${translationRoot}.title`)}
            </div>
            <div className="text-[10px]" style={{ color: "var(--cs-text-tertiary)" }}>
              {limits?.updatedAt ? formatUpdatedAt(limits.updatedAt, t) : t(`${translationRoot}.pending`)}
            </div>
          </div>
        </div>
        {agentId === "codex" ? <button
          type="button"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] transition-colors"
          style={{
            color: "var(--cs-text-tertiary)",
            background: "transparent",
            border: "0",
            cursor: isLoading ? "wait" : "pointer",
          }}
          disabled={isLoading}
          title={t("common.refresh")}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRefresh();
          }}
        >
          {isLoading ? <LoadingOutlined style={{ fontSize: 12 }} /> : <ReloadOutlined style={{ fontSize: 12 }} />}
        </button> : null}
      </div>

      <div className="space-y-3 px-3 py-3">
        {hasData ? (
          <>
            {limits?.session ? (
              <CodexUsageWindowRow
                label={t("statusBar.codexUsage.session")}
                window={limits.session}
              />
            ) : null}
            {limits?.weekly ? (
              <CodexUsageWindowRow
                label={t("statusBar.codexUsage.weekly")}
                window={limits.weekly}
              />
            ) : null}
          </>
        ) : (
          <div className="flex items-start gap-2 text-[12px]" style={{ color: "var(--cs-text-tertiary)" }}>
            {isLoading ? (
              <LoadingOutlined style={{ fontSize: 12, marginTop: 2 }} />
            ) : (
              <WarningOutlined style={{ fontSize: 12, marginTop: 2 }} />
            )}
            <span>{statusError || t(`${translationRoot}.unavailable`)}</span>
          </div>
        )}

        {resetCredits != null ? (
          <div
            className="border-y py-2 text-[11px] font-medium"
            style={{
              color: "var(--cs-text-secondary)",
              borderColor: "color-mix(in srgb, var(--cs-border-sidebar) 76%, transparent)",
            }}
          >
            {t("statusBar.codexUsage.resetCredits", { count: resetCredits })}
          </div>
        ) : null}

        {agentId === "codex" ? <div
          className="space-y-1 border-t pt-2 text-[11px]"
          style={{ borderColor: "color-mix(in srgb, var(--cs-border-sidebar) 76%, transparent)" }}
        >
          <div className="flex items-center justify-between gap-3">
            <span style={{ color: "var(--cs-text-tertiary)" }}>{t("statusBar.codexUsage.account")}</span>
            <span
              className="min-w-0 truncate text-right"
              style={{ color: "var(--cs-text-secondary)" }}
              title={codexLimits?.accountLabel ?? undefined}
            >
              {codexLimits?.accountLabel ?? t("statusBar.codexUsage.systemDefault")}
            </span>
          </div>
          {statusError && hasData ? (
            <div className="flex items-start gap-1.5" style={{ color: "var(--cs-text-tertiary)" }}>
              <WarningOutlined style={{ fontSize: 11, marginTop: 2 }} />
              <span className="min-w-0 break-words">{statusError}</span>
            </div>
          ) : null}
        </div> : null}
      </div>
    </div>
  );

  return (
    <Popover
      trigger={["click"]}
      placement="topLeft"
      content={popoverContent}
      arrow={false}
      overlayInnerStyle={{ padding: 0, background: "transparent", boxShadow: "none" }}
      styles={{ body: { padding: 0 } }}
      getPopupContainer={() => document.body}
    >
      <button
        type="button"
        className="flex h-7 min-w-[154px] shrink-0 items-center justify-start gap-2 rounded-[5px] px-2 text-left text-[13px] font-medium leading-none transition-colors"
        style={{
          background: "transparent",
          border: "0",
          color: hasData ? "var(--cs-text-secondary)" : "var(--cs-text-tertiary)",
          cursor: "pointer",
        }}
        title={summary}
      >
        <AgentIcon agentId={agentId} size={15} />
        <div
          aria-hidden="true"
          className="h-[6px] w-14 shrink-0 overflow-hidden rounded-full"
          style={{
            background: "color-mix(in srgb, var(--cs-text-tertiary) 24%, transparent)",
            opacity: compactRemaining == null ? 0.55 : 1,
          }}
        >
          <div
            className="h-full rounded-full transition-[width] duration-200"
            style={{
              width: `${compactRemaining ?? 0}%`,
              background: compactBarColor,
              boxShadow: compactRemaining == null
                ? "none"
                : `0 0 5px color-mix(in srgb, ${compactBarColor} 55%, transparent)`,
            }}
          />
        </div>
        <span className="truncate tabular-nums">{summary}</span>
        {isLoading ? (
          <LoadingOutlined style={{ fontSize: 12, color: "var(--cs-text-tertiary)" }} />
        ) : statusError ? (
          <WarningOutlined style={{ fontSize: 12, color: "var(--cs-text-tertiary)" }} />
        ) : null}
      </button>
    </Popover>
  );
}

function CodexUsageWindowRow({
  label,
  window,
}: {
  label: string;
  window: CodexRateLimitWindow;
}) {
  const { t } = useTranslation();
  const remaining = remainingPercent(window);
  const resetLabel = formatResetLabel(window, t);
  const barColor = codexUsageBarColor(remaining);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-[12px]">
        <span className="font-medium" style={{ color: "var(--cs-text-primary)" }}>
          {label}
        </span>
        <span className="tabular-nums" style={{ color: "var(--cs-text-secondary)" }}>
          {t("statusBar.codexUsage.remaining", { value: remaining })}
        </span>
      </div>
      <div
        className="h-[6px] overflow-hidden rounded-full"
        style={{ background: "color-mix(in srgb, var(--cs-text-tertiary) 24%, transparent)" }}
      >
        <div
          className="h-full rounded-full transition-[width] duration-200"
          style={{
            width: `${remaining}%`,
            background: barColor,
            boxShadow: `0 0 5px color-mix(in srgb, ${barColor} 55%, transparent)`,
          }}
        />
      </div>
      <div className="text-[11px]" style={{ color: "var(--cs-text-tertiary)" }}>
        {resetLabel}
      </div>
    </div>
  );
}

function formatRateLimitUsageSummary(
  limits: ClaudeRateLimits | CodexRateLimits | null,
  isLoading: boolean,
  error: string | null,
  t: TFunction,
  translationRoot: "statusBar.claudeUsage" | "statusBar.codexUsage",
): string {
  const parts: string[] = [];
  if (limits?.session) {
    parts.push(`${remainingPercent(limits.session)}% ${formatWindowCompact(limits.session, t)}`);
  }
  if (limits?.weekly) {
    parts.push(`${remainingPercent(limits.weekly)}% ${formatWindowCompact(limits.weekly, t)}`);
  }
  if (parts.length > 0) {
    return parts.join(" · ");
  }
  if (isLoading) {
    return t(`${translationRoot}.loading`);
  }
  if (error) {
    return t(`${translationRoot}.unavailableShort`);
  }
  return t(`${translationRoot}.pending`);
}

function remainingPercent(window: CodexRateLimitWindow): number {
  return Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)));
}

function formatWindowCompact(
  window: CodexRateLimitWindow,
  t: TFunction,
): string {
  if (window.windowMinutes === 300) {
    return t("statusBar.codexUsage.sessionCompact");
  }
  if (window.windowMinutes === 10_080) {
    return t("statusBar.codexUsage.weeklyCompact");
  }
  return t("statusBar.codexUsage.hoursCompact", {
    hours: Math.round(window.windowMinutes / 60),
  });
}

function formatResetLabel(
  window: CodexRateLimitWindow,
  t: TFunction,
): string {
  if (window.resetsAt) {
    const diffMs = window.resetsAt - Date.now();
    if (diffMs <= 0) {
      return t("statusBar.codexUsage.resetsSoon");
    }
    const totalMinutes = Math.max(1, Math.round(diffMs / 60_000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours <= 0) {
      return t("statusBar.codexUsage.resetsInMinutes", { minutes });
    }
    if (hours < 48) {
      return minutes > 0
        ? t("statusBar.codexUsage.resetsInHoursMinutes", { hours, minutes })
        : t("statusBar.codexUsage.resetsInHours", { hours });
    }
    return t("statusBar.codexUsage.resetsAt", {
      time: new Date(window.resetsAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    });
  }
  if (window.resetDescription) {
    return t("statusBar.codexUsage.resetsAt", { time: window.resetDescription });
  }
  return t("statusBar.codexUsage.resetUnknown");
}

function formatUpdatedAt(updatedAt: number, t: TFunction): string {
  const diffMs = Math.max(0, Date.now() - updatedAt);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) {
    return t("statusBar.codexUsage.updatedNow");
  }
  if (minutes < 60) {
    return t("statusBar.codexUsage.updatedMinutes", { minutes });
  }
  const hours = Math.floor(minutes / 60);
  return t("statusBar.codexUsage.updatedHours", { hours });
}

function codexUsageBarColor(remaining: number): string {
  if (remaining <= 15) return "var(--cs-error)";
  if (remaining <= 35) return "var(--cs-warning)";
  return "var(--cs-success)";
}

function simplifyRemoteUrl(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  try {
    const normalized = remoteUrl.replace(/^git@/i, "ssh://");
    const url = new URL(normalized);
    return `${url.host}${url.pathname.replace(/\.git$/i, "")}`;
  } catch {
    return remoteUrl.replace(/\.git$/i, "");
  }
}

export default StatusBar;
