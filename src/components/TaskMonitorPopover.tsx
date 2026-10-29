import { useEffect, useState, useMemo } from "react";
import { Popover, Tooltip, message } from "antd";
import {
  CloseOutlined,
  FolderOpenOutlined,
  FileSearchOutlined,
  LoadingOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  AppstoreOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/store";
import { focusProjectWindow } from "@/lib/api";
import { projectPathKey } from "@/lib/openProjects";
import { collectTaskMonitorProjects, collectTaskMonitorTabs, type TaskMonitorTab } from "@/lib/taskMonitor";
import { useOpenProjectsStore } from "@/store/slices/openProjects";
import {
  requestTaskMonitorSnapshots,
  requestTaskMonitorTabClose,
  requestTaskMonitorProjectClose,
  startTaskMonitorSync,
  useTaskMonitorStore,
} from "@/store/slices/taskMonitor";
import { AgentIcon } from "@/components/AgentIcon";
import { getAgentDisplayName, isAiAgentId } from "@/lib/agents";

function TaskStatusBadge({ status }: { status: TaskMonitorTab["status"] }) {
  const { t } = useTranslation();

  if (status === "running" || status === "starting") {
    return (
      <span className="app-task-monitor-status-badge" data-status="running">
        <LoadingOutlined spin className="app-task-monitor-status-icon text-[var(--cs-primary)]" />
        <span className="app-task-monitor-status-text">{t(`taskMonitor.status.${status}`)}</span>
      </span>
    );
  }

  if (status === "waiting") {
    return (
      <span className="app-task-monitor-status-badge" data-status="waiting">
        <span className="app-task-monitor-pulse-dot" />
        <span className="app-task-monitor-status-text">{t("taskMonitor.status.waiting")}</span>
      </span>
    );
  }

  if (status === "completed") {
    return (
      <span className="app-task-monitor-status-badge" data-status="completed">
        <CheckCircleOutlined className="app-task-monitor-status-icon text-[var(--cs-success)]" />
        <span className="app-task-monitor-status-text">{t("taskMonitor.status.completed")}</span>
      </span>
    );
  }

  if (status === "error") {
    return (
      <span className="app-task-monitor-status-badge" data-status="error">
        <CloseCircleOutlined className="app-task-monitor-status-icon text-[var(--cs-error)]" />
        <span className="app-task-monitor-status-text">{t("taskMonitor.status.error")}</span>
      </span>
    );
  }

  return (
    <span className="app-task-monitor-status-badge" data-status="idle">
      <span className="app-task-monitor-idle-dot" />
      <span className="app-task-monitor-status-text">{t("taskMonitor.status.idle")}</span>
    </span>
  );
}

interface TaskMonitorPanelProps {
  active: boolean;
  embedded?: boolean;
  onBeforeCloseProject?: () => void;
}

export function TaskMonitorPanel({
  active,
  embedded = false,
  onBeforeCloseProject,
}: TaskMonitorPanelProps) {
  const { t } = useTranslation();
  const currentProject = useAppStore((s) => s.currentProject);
  const sessions = useAppStore((s) => s.sessions);
  const panes = useAppStore((s) => s.panesById);
  const tabs = useAppStore((s) => s.tabsById);
  const focusedTabId = useAppStore((s) => s.focusedTabId);
  const windowLabel = useAppStore((s) => s.windowLabel);
  const windows = useOpenProjectsStore((s) => s.windows);
  const refreshWindows = useOpenProjectsStore((s) => s.setOpenProjectWindows);
  const snapshots = useTaskMonitorStore((s) => s.snapshots);
  const projects = collectTaskMonitorProjects(windows, currentProject);

  useEffect(() => {
    if (!active) return;
    const refresh = () => {
      void refreshWindows();
      void requestTaskMonitorSnapshots().catch((error) => console.error("Task monitor refresh failed:", error));
    };
    refresh();
    const interval = window.setInterval(refresh, 2000);
    return () => window.clearInterval(interval);
  }, [active, refreshWindows]);

  const projectsWithTabs = useMemo(() => {
    return projects.map((project) => {
      const key = projectPathKey(project.path);
      const isCurrent = !!currentProject && projectPathKey(currentProject.path) === key;
      const projectWindow = windows.find((item) => item.projectPath && projectPathKey(item.projectPath) === key);
      const targetWindowLabel = isCurrent ? windowLabel : projectWindow?.windowLabel;
      const snapshot = projectWindow ? snapshots[projectWindow.windowLabel] : undefined;
      const projectTabs = isCurrent ? collectTaskMonitorTabs(sessions, panes, tabs)
        : snapshot && projectPathKey(snapshot.projectPath) === key ? snapshot.tabs : null;

      return {
        project,
        key,
        isCurrent,
        targetWindowLabel,
        projectTabs,
      };
    });
  }, [projects, currentProject, windows, windowLabel, snapshots, sessions, panes, tabs]);

  const summary = useMemo(() => {
    let running = 0;
    let waiting = 0;
    let completed = 0;
    let error = 0;
    let totalTabs = 0;

    for (const item of projectsWithTabs) {
      if (!item.projectTabs) continue;
      totalTabs += item.projectTabs.length;
      for (const tab of item.projectTabs) {
        if (tab.status === "running" || tab.status === "starting") running += 1;
        else if (tab.status === "waiting") waiting += 1;
        else if (tab.status === "completed") completed += 1;
        else if (tab.status === "error") error += 1;
      }
    }

    return {
      totalProjects: projects.length,
      totalTabs,
      running,
      waiting,
      completed,
      error,
    };
  }, [projectsWithTabs, projects.length]);

  async function navigate(projectPath: string, tab: TaskMonitorTab) {
    if (currentProject && projectPathKey(currentProject.path) === projectPathKey(projectPath)) {
      useAppStore.getState().setActiveSession(tab.id, tab.paneId);
      return;
    }
    try {
      if (!await focusProjectWindow(projectPath, tab.id)) {
        message.error(t("taskMonitor.navigateFailed"));
        void refreshWindows();
      }
    } catch (error) {
      console.error("Failed to navigate to monitored task:", error);
      message.error(t("taskMonitor.navigateFailed"));
    }
  }

  async function closeTask(targetWindowLabel: string, tabId: string) {
    try {
      await requestTaskMonitorTabClose({ windowLabel: targetWindowLabel, tabId });
    } catch (error) {
      console.error("Failed to close monitored task:", error);
      message.error(t("taskMonitor.closeFailed"));
    }
  }

  async function closeProject(targetWindowLabel: string, projectPath: string) {
    onBeforeCloseProject?.();
    try {
      // 先恢复目标窗口，让常驻关闭对话框在用户可见的窗口中展示。
      if (!await focusProjectWindow(projectPath, "")) throw new Error("Project window unavailable");
      await requestTaskMonitorProjectClose(targetWindowLabel, projectPath);
    } catch (error) {
      console.error("Failed to close monitored project:", error);
      message.error(t("taskMonitor.closeProjectFailed"));
    }
  }

  return (
    <div className={`app-task-monitor ${embedded ? "app-task-monitor-embedded" : ""}`}>
      {/* 顶部概览统计条（Container Query 自适应紧凑模式） */}
      <div className="app-task-monitor-summary" role="region" aria-label={t("taskMonitor.overview", { count: summary.totalProjects })}>
        <Tooltip title={t("taskMonitor.overview", { count: summary.totalProjects })}>
          <div className="app-task-monitor-stat-pill" data-variant="default">
            <AppstoreOutlined className="text-[var(--cs-text-tertiary)]" />
            <span className="tabular-nums font-semibold">{summary.totalProjects}</span>
            <span className="app-task-monitor-stat-label">{t("taskMonitor.projectsUnit")}</span>
          </div>
        </Tooltip>

        {summary.running > 0 && (
          <Tooltip title={t("taskMonitor.runningHint", { count: summary.running })}>
            <div className="app-task-monitor-stat-pill" data-variant="running">
              <LoadingOutlined spin />
              <span className="tabular-nums font-semibold">{summary.running}</span>
              <span className="app-task-monitor-stat-label">{t("taskMonitor.runningUnit")}</span>
            </div>
          </Tooltip>
        )}

        {summary.waiting > 0 && (
          <Tooltip title={t("taskMonitor.waitingHint", { count: summary.waiting })}>
            <div className="app-task-monitor-stat-pill" data-variant="waiting">
              <span className="app-task-monitor-pulse-dot" />
              <span className="tabular-nums font-semibold">{summary.waiting}</span>
              <span className="app-task-monitor-stat-label">{t("taskMonitor.waitingUnit")}</span>
            </div>
          </Tooltip>
        )}

        {summary.error > 0 && (
          <Tooltip title={t("taskMonitor.errorHint", { count: summary.error })}>
            <div className="app-task-monitor-stat-pill" data-variant="error">
              <CloseCircleOutlined />
              <span className="tabular-nums font-semibold">{summary.error}</span>
              <span className="app-task-monitor-stat-label">{t("taskMonitor.errorUnit")}</span>
            </div>
          </Tooltip>
        )}

        {summary.completed > 0 && (
          <Tooltip title={t("taskMonitor.completedHint", { count: summary.completed })}>
            <div className="app-task-monitor-stat-pill" data-variant="completed">
              <CheckCircleOutlined />
              <span className="tabular-nums font-semibold">{summary.completed}</span>
              <span className="app-task-monitor-stat-label">{t("taskMonitor.completedUnit")}</span>
            </div>
          </Tooltip>
        )}
      </div>

      <div className="app-task-monitor-projects">
        {projectsWithTabs.length === 0 && (
          <div className="app-task-monitor-empty-container">
            <AppstoreOutlined className="text-2xl text-[var(--cs-text-tertiary)] opacity-60 mb-2" />
            <p className="app-task-monitor-empty m-0">{t("taskMonitor.noProjects")}</p>
          </div>
        )}

        {projectsWithTabs.map(({ project, key, isCurrent, targetWindowLabel, projectTabs }) => {
          return (
            <section
              key={key}
              className="app-task-monitor-project"
              data-current={isCurrent ? "true" : "false"}
              aria-label={project.name}
            >
              <div className="app-task-monitor-project-header">
                <FolderOpenOutlined className="app-task-monitor-folder-icon" />
                <span className="app-task-monitor-project-name min-w-0 flex-1 truncate" title={project.path}>
                  {project.name}
                </span>
                {isCurrent && (
                  <span className="app-task-monitor-current-badge">
                    {t("taskMonitor.current")}
                  </span>
                )}
                {projectTabs && projectTabs.length > 0 && (
                  <span className="app-task-monitor-count-badge" title={t("taskMonitor.tabCount", { count: projectTabs.length })}>
                    {projectTabs.length}
                  </span>
                )}
                {targetWindowLabel && (
                  <Tooltip title={t("taskMonitor.closeProject")}>
                    <button
                      type="button"
                      className="app-task-monitor-project-close"
                      aria-label={t("taskMonitor.closeProject")}
                      onClick={() => void closeProject(targetWindowLabel, project.path)}
                    >
                      <CloseOutlined />
                    </button>
                  </Tooltip>
                )}
              </div>

              {(!projectTabs || projectTabs.length === 0) ? (
                <div className="app-task-monitor-empty-state">
                  <span>{t(projectTabs ? "taskMonitor.noTabs" : "taskMonitor.loading")}</span>
                </div>
              ) : (
                <div className="app-task-monitor-tab-list">
                  {projectTabs.map((tab) => {
                    const isActive = isCurrent && focusedTabId === tab.id;
                    const agentName = isAiAgentId(tab.agentId) ? getAgentDisplayName(tab.agentId) : tab.agentId;
                    return (
                      <div
                        key={tab.id}
                        className="app-task-monitor-row"
                        data-closable={targetWindowLabel ? "true" : "false"}
                        data-active={isActive ? "true" : "false"}
                      >
                        <button
                          type="button"
                          className="app-task-monitor-row-main"
                          onClick={() => void navigate(project.path, tab)}
                          title={`${tab.name} · ${agentName}`}
                        >
                          <Tooltip title={agentName}>
                            <span className="app-task-monitor-agent-icon">
                              <AgentIcon agentId={tab.agentId} size={15} />
                            </span>
                          </Tooltip>
                          <span className="app-task-monitor-row-title min-w-0 flex-1 truncate text-left">
                            {tab.name}
                          </span>
                          <TaskStatusBadge status={tab.status} />
                        </button>
                        {targetWindowLabel && (
                          <Tooltip title={t("taskMonitor.closeTask")}>
                            <button
                              type="button"
                              className="app-task-monitor-close"
                              aria-label={t("taskMonitor.closeTask")}
                              onClick={() => void closeTask(targetWindowLabel, tab.id)}
                            >
                              <CloseOutlined />
                            </button>
                          </Tooltip>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function TaskMonitorPopover() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);

  useEffect(() => startTaskMonitorSync((error) => {
    message.error(error instanceof Error && error.message === "application-update-in-progress"
      ? t("updater.keepOpenDuringDownload") : t("taskMonitor.closeProjectFailed"));
  }), [t]);

  return (
    <div className="app-task-monitor-trigger-wrap">
      <Popover
        open={open}
        trigger={[]}
        placement="bottomRight"
        arrow={false}
        content={<TaskMonitorPanel active={open} onBeforeCloseProject={() => setOpen(false)} />}
        overlayClassName="app-task-monitor-popover"
      >
        <Tooltip title={t("taskMonitor.title")} mouseEnterDelay={0.4}
          open={!open && tooltipOpen} onOpenChange={setTooltipOpen}>
          <button type="button"
            className="app-rail-button app-marker-host app-marker-rail mr-1 flex h-8 w-10 items-center justify-center rounded-md"
            aria-label={t("taskMonitor.title")} aria-pressed={open} data-active={open ? "true" : "false"}
            onClick={() => { setTooltipOpen(false); setOpen((current) => !current); }}>
            <FileSearchOutlined />
          </button>
        </Tooltip>
      </Popover>
    </div>
  );
}
