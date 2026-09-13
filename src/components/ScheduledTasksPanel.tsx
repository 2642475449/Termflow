import {
  Alert,
  Button,
  Empty,
  Popconfirm,
  Spin,
  Switch,
  Tag,
  Tooltip,
  message,
} from "antd";
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CodeOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  FileTextOutlined,
  LeftOutlined,
  LoadingOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  cancelScheduledTaskRun,
  deleteScheduledTask,
  getScheduledTaskRun,
  getScheduledTaskRunLog,
  runScheduledTaskNow,
  setScheduledTaskEnabled,
} from "@/lib/api";
import {
  getLatestRunByTask,
  isScheduledTaskFinished,
  isScheduledTaskRunActive,
  parseScheduledTaskLog,
} from "@/lib/scheduledTasks";
import { useAppStore } from "@/store";
import {
  refreshScheduledTasks,
  useScheduledTaskStore,
} from "@/store/slices/scheduledTasks";
import type {
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskRunStatus,
} from "@/types";
import { ScheduledTaskForm } from "./ScheduledTaskForm";
import MarkdownPreview from "./markdown/MarkdownPreview";

function formatDateTime(timestamp: number | null, locale: string, timezone?: string): string | null {
  if (timestamp === null) return null;
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(timestamp);
  } catch {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(timestamp);
  }
}

function formatDuration(
  startedAtMs: number | null,
  completedAtMs: number | null,
  t: TFunction,
): string | null {
  if (startedAtMs === null || completedAtMs === null) return null;
  const seconds = Math.max(0, Math.round((completedAtMs - startedAtMs) / 1000));
  if (seconds < 60) return t("scheduledTasks.durationSeconds", { count: seconds });
  return t("scheduledTasks.durationMinutesSeconds", {
    minutes: Math.floor(seconds / 60),
    seconds: seconds % 60,
  });
}

function RunStatusIcon({ status }: { status: ScheduledTaskRunStatus }) {
  if (status === "succeeded") return <CheckCircleOutlined className="app-scheduled-status-success" />;
  if (status === "queued" || status === "running") return <LoadingOutlined className="app-scheduled-status-running" />;
  if (status === "cancelled" || status === "skipped") return <PauseCircleOutlined className="app-scheduled-status-muted" />;
  return <ExclamationCircleOutlined className="app-scheduled-status-error" />;
}

function ScheduledTaskRunDetail({
  run,
  onBack,
}: {
  run: ScheduledTaskRun;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [detail, setDetail] = useState<ScheduledTaskRun>(run);
  const [log, setLog] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    let disposed = false;
    void Promise.all([
      getScheduledTaskRun(run.id),
      run.logAvailable ? getScheduledTaskRunLog(run.id) : Promise.resolve(""),
    ])
      .then(([nextDetail, nextLog]) => {
        if (!disposed) {
          setDetail(nextDetail);
          setLog(nextLog);
        }
      })
      .catch((error: unknown) => {
        if (!disposed) setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [run.id, run.logAvailable]);

  async function handleCancel() {
    setCancelling(true);
    try {
      await cancelScheduledTaskRun(detail.id);
      await refreshScheduledTasks();
      message.success(t("scheduledTasks.cancelRequested"));
      onBack();
    } catch (error: unknown) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCancelling(false);
    }
  }

  const statusKey = `scheduledTasks.runStatus.${detail.status}`;
  const timestamp = detail.startedAtMs ?? detail.createdAtMs;
  const parsedLog = useMemo(() => parseScheduledTaskLog(log ?? ""), [log]);
  const isAgent = detail.configSnapshot.executionKind === "agent";
  const output = isAgent ? parsedLog.output : [parsedLog.output, parsedLog.diagnostics].filter(Boolean).join("\n\n");
  return (
    <section className="app-scheduled-run-detail">
      <div className="app-scheduled-detail-header">
        <Button type="text" icon={<LeftOutlined />} onClick={onBack}>{t("scheduledTasks.backToList")}</Button>
        {isScheduledTaskRunActive(detail.status) && (
          <Button danger icon={<StopOutlined />} loading={cancelling} onClick={() => void handleCancel()}>
            {t("scheduledTasks.cancelRun")}
          </Button>
        )}
      </div>
      <div className="app-scheduled-detail-title">
        <RunStatusIcon status={detail.status} />
        <div>
          <h1>{detail.taskName}</h1>
          <p>{t(statusKey)}</p>
        </div>
      </div>
      {loadError && <Alert className="mb-4" type="error" showIcon message={loadError} />}
      {loading ? <div className="app-scheduled-loading"><Spin /></div> : (
        <>
          <dl className="app-scheduled-detail-grid">
            <div><dt>{t("scheduledTasks.trigger")}</dt><dd>{t(`scheduledTasks.triggerType.${detail.trigger}`)}</dd></div>
            <div><dt>{t("scheduledTasks.scheduledAt")}</dt><dd>{formatDateTime(detail.scheduledAtMs, i18n.language, detail.configSnapshot.timezone) ?? t("scheduledTasks.notAvailable")}</dd></div>
            <div><dt>{t("scheduledTasks.startedAt")}</dt><dd>{formatDateTime(timestamp, i18n.language) ?? t("scheduledTasks.unknownTime")}</dd></div>
            <div><dt>{t("scheduledTasks.completedAt")}</dt><dd>{formatDateTime(detail.completedAtMs, i18n.language) ?? t("scheduledTasks.notCompleted")}</dd></div>
            <div><dt>{t("scheduledTasks.duration")}</dt><dd>{formatDuration(detail.startedAtMs, detail.completedAtMs, t) ?? t("scheduledTasks.unknownDuration")}</dd></div>
            <div><dt>{t("scheduledTasks.exitCode")}</dt><dd>{detail.exitCode ?? t("scheduledTasks.notAvailable")}</dd></div>
            <div><dt>{t("scheduledTasks.result")}</dt><dd>{detail.summary ?? detail.error ?? t("scheduledTasks.notAvailable")}</dd></div>
          </dl>
          <div className="app-scheduled-log-section">
            <h2>{t("scheduledTasks.output")}</h2>
            {output ? (isAgent ? (
              <MarkdownPreview
                content={output}
                emptyText={t("scheduledTasks.noOutput")}
                projectPath={detail.projectPath}
                className="app-scheduled-result"
              />
            ) : <pre className="app-scheduled-log">{output}</pre>) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("scheduledTasks.noOutput")} />
            )}
            {log && (
              <details className="app-scheduled-diagnostics">
                <summary>{t("scheduledTasks.rawLog")}</summary>
                <pre className="app-scheduled-log">{log}</pre>
              </details>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export default function ScheduledTasksPanel() {
  const { t, i18n } = useTranslation();
  const currentProject = useAppStore((state) => state.currentProject);
  const tasks = useScheduledTaskStore((state) => state.tasks);
  const runs = useScheduledTaskStore((state) => state.runs);
  const loading = useScheduledTaskStore((state) => state.loading);
  const initialized = useScheduledTaskStore((state) => state.initialized);
  const loadError = useScheduledTaskStore((state) => state.error);
  const scope = useScheduledTaskStore((state) => state.scope);
  const selectedRunId = useScheduledTaskStore((state) => state.selectedRunId);
  const setSelectedRunId = useScheduledTaskStore((state) => state.setSelectedRunId);
  const editor = useScheduledTaskStore((state) => state.editor);
  const setEditor = useScheduledTaskStore((state) => state.setEditor);
  const [showAllRuns, setShowAllRuns] = useState(false);

  const scopeProjectPath = scope === "all"
    ? null
    : scope === "current"
      ? currentProject?.path ?? null
      : scope;
  const scopedTasks = useMemo(
    () => tasks
      .filter((task) => scopeProjectPath === null ? scope === "all" : task.projectPath === scopeProjectPath)
      .sort((left, right) => (left.nextRunAtMs ?? Number.MAX_SAFE_INTEGER) - (right.nextRunAtMs ?? Number.MAX_SAFE_INTEGER)),
    [scope, scopeProjectPath, tasks],
  );
  const matchingRuns = useMemo(
    () => runs
      .filter((run) => scopeProjectPath === null ? scope === "all" : run.projectPath === scopeProjectPath),
    [runs, scope, scopeProjectPath],
  );
  const scopedRuns = showAllRuns ? matchingRuns : matchingRuns.slice(0, 5);
  const latestRuns = useMemo(() => getLatestRunByTask(runs), [runs]);
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;
  const projects = useMemo(() => {
    const entries = new Map(tasks.map((task) => [task.projectPath, {
      path: task.projectPath,
      name: task.projectName,
    }]));
    if (currentProject) entries.set(currentProject.path, currentProject);
    return [...entries.values()];
  }, [currentProject, tasks]);

  const scopeName = scope === "all"
    ? t("scheduledTasks.allProjects")
    : scope === "current"
      ? currentProject?.name ?? t("scheduledTasks.noProject")
      : tasks.find((task) => task.projectPath === scope)?.projectName ?? scope;

  const getScheduleSummary = (task: ScheduledTask) => {
    switch (task.schedule.kind) {
      case "once":
        return t("scheduledTasks.onceAt", { time: formatDateTime(task.schedule.runAtMs, i18n.language, task.timezone) });
      case "interval":
        return t("scheduledTasks.everyMinutes", { count: task.schedule.intervalMinutes });
      case "daily":
        return t("scheduledTasks.everyDayAt", { time: task.schedule.time });
      case "weekly":
        return t("scheduledTasks.everyWeekAt", {
          weekday: t(`scheduledTasks.weekdays.${["mon", "tue", "wed", "thu", "fri", "sat", "sun"][task.schedule.weekday - 1]}`),
          time: task.schedule.time,
        });
    }
  };

  async function handleToggle(task: ScheduledTask, enabled: boolean) {
    try {
      await setScheduledTaskEnabled(task.id, enabled);
      await refreshScheduledTasks();
    } catch (error: unknown) {
      message.error(error instanceof Error ? error.message : String(error));
      void refreshScheduledTasks();
    }
  }

  async function handleRun(task: ScheduledTask) {
    try {
      await runScheduledTaskNow(task.id);
      await refreshScheduledTasks();
      message.success(t("scheduledTasks.runStarted"));
    } catch (error: unknown) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleDelete(task: ScheduledTask) {
    try {
      await deleteScheduledTask(task.id);
      await refreshScheduledTasks();
      message.success(t("scheduledTasks.deleteSuccess"));
    } catch (error: unknown) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }

  if (selectedRun) {
    return <ScheduledTaskRunDetail run={selectedRun} onBack={() => setSelectedRunId(null)} />;
  }

  const editingTask = editor && editor !== "create"
    ? tasks.find((task) => task.id === editor) ?? null
    : null;

  if (editor) {
    return (
      <ScheduledTaskForm
        task={editingTask}
        projects={projects}
        currentProjectPath={currentProject?.path ?? null}
        onCancel={() => setEditor(null)}
        onSaved={() => {
          message.success(t(editor === "create" ? "scheduledTasks.createSuccess" : "scheduledTasks.saveSuccess"));
          setEditor(null);
        }}
      />
    );
  }

  return (
    <section className="app-scheduled-tasks h-full overflow-y-auto">
      <div className="app-scheduled-content">
        <div className="app-scheduled-page-header">
          <div>
            <h1>{t("scheduledTasks.title")}</h1>
            <p>{t("scheduledTasks.subtitle", { project: scopeName })}</p>
          </div>
          <Button type="primary" icon={<ClockCircleOutlined />} disabled={!currentProject && projects.length === 0} onClick={() => setEditor("create")}>
            {t("scheduledTasks.newTask")}
          </Button>
        </div>

        {loadError && (
          <Alert
            className="mb-4"
            type="error"
            showIcon
            message={t("scheduledTasks.loadFailed")}
            description={loadError}
            action={<Button size="small" onClick={() => void refreshScheduledTasks()}>{t("common.refresh")}</Button>}
          />
        )}
        {!initialized && loading ? <div className="app-scheduled-loading"><Spin /></div> : scopedTasks.length === 0 ? (
          <div className="app-scheduled-empty">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={scope === "current" && !currentProject ? t("scheduledTasks.noProject") : t("scheduledTasks.emptyDescription")}
            >
              {currentProject && <Button type="primary" onClick={() => setEditor("create")}>{t("scheduledTasks.createTask")}</Button>}
            </Empty>
          </div>
        ) : (
          <div className="app-scheduled-task-list">
            {scopedTasks.map((task) => {
              const latestRun = latestRuns.get(task.id);
              const active = latestRun ? isScheduledTaskRunActive(latestRun.status) : false;
              const finished = isScheduledTaskFinished(task);
              const taskStatus = active
                ? t(`scheduledTasks.runStatus.${latestRun?.status}`)
                : finished
                  ? t("scheduledTasks.finished")
                  : task.enabled ? t("scheduledTasks.enabled") : t("scheduledTasks.paused");
              return (
                <article key={task.id} className="app-scheduled-task-row">
                  <div className="app-scheduled-task-icon" aria-hidden="true">
                    {task.executionKind === "agent" ? <FileTextOutlined /> : <CodeOutlined />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="app-scheduled-task-title">
                      <button type="button" className="app-scheduled-task-name" onClick={() => setEditor(task.id)}>{task.name}</button>
                      <Tag className={active ? "app-scheduled-tag-running" : task.enabled ? "app-scheduled-tag-enabled" : "app-scheduled-tag-muted"}>{taskStatus}</Tag>
                    </div>
                    <div className="app-scheduled-task-meta">
                      <span>{task.executionKind === "agent" ? task.agentId?.toUpperCase() : task.shell?.toUpperCase()}</span>
                      <span>{getScheduleSummary(task)}</span>
                      {scope === "all" && <span>{task.projectName}</span>}
                    </div>
                    <div className="app-scheduled-task-next">
                      {task.nextRunAtMs !== null
                        ? t("scheduledTasks.nextRun", { time: formatDateTime(task.nextRunAtMs, i18n.language, task.timezone) })
                        : finished ? t("scheduledTasks.finishedHint") : t("scheduledTasks.pausedHint")}
                    </div>
                  </div>
                  <div className="app-scheduled-task-actions">
                    <Tooltip title={t("scheduledTasks.runNow")}>
                      <Button type="text" shape="circle" icon={<PlayCircleOutlined />} disabled={active} onClick={() => void handleRun(task)} />
                    </Tooltip>
                    <Tooltip title={t("scheduledTasks.editTask")}>
                      <Button type="text" shape="circle" icon={<EditOutlined />} onClick={() => setEditor(task.id)} />
                    </Tooltip>
                    <Popconfirm
                      title={t("scheduledTasks.deleteTask")}
                      description={t("scheduledTasks.deleteConfirm", { name: task.name })}
                      okText={t("common.delete")}
                      cancelText={t("common.cancel")}
                      onConfirm={() => handleDelete(task)}
                    >
                      <Button type="text" danger shape="circle" icon={<DeleteOutlined />} aria-label={t("scheduledTasks.deleteTask")} />
                    </Popconfirm>
                    <Switch checked={task.enabled} disabled={finished} onChange={(enabled) => void handleToggle(task, enabled)} aria-label={t("scheduledTasks.toggleTask", { name: task.name })} />
                  </div>
                </article>
              );
            })}
          </div>
        )}

        <div className="app-scheduled-runs-header">
          <h2>{t("scheduledTasks.recentRuns")}</h2>
          <div className="app-scheduled-runs-actions">
            {matchingRuns.length > 5 && (
              <Button type="text" onClick={() => setShowAllRuns((visible) => !visible)}>
                {t(showAllRuns ? "scheduledTasks.showRecentRuns" : "scheduledTasks.viewAllRuns")}
              </Button>
            )}
            <Button type="text" icon={<ReloadOutlined />} onClick={() => void refreshScheduledTasks()}>{t("common.refresh")}</Button>
          </div>
        </div>
        {scopedRuns.length === 0 ? (
          <div className="app-scheduled-runs-empty">{t("scheduledTasks.noRuns")}</div>
        ) : (
          <div className="app-scheduled-run-list">
            {scopedRuns.map((run) => (
              <button key={run.id} type="button" className="app-scheduled-run-row" onClick={() => setSelectedRunId(run.id)}>
                <RunStatusIcon status={run.status} />
                <span className="min-w-0 flex-1 truncate text-left">{run.taskName}</span>
                <span>{formatDateTime(run.startedAtMs ?? run.createdAtMs, i18n.language)}</span>
                <span>{formatDuration(run.startedAtMs, run.completedAtMs, t) ?? t(`scheduledTasks.runStatus.${run.status}`)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
