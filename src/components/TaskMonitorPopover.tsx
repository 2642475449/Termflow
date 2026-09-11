import { useEffect, useState } from "react";
import { Popover, Tooltip, message } from "antd";
import { FileSearchOutlined, FolderOpenOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/store";
import { focusProjectWindow } from "@/lib/api";
import { collectOpenProjects, projectPathKey } from "@/lib/openProjects";
import { collectTaskMonitorTabs, type TaskMonitorTab } from "@/lib/taskMonitor";
import { useOpenProjectsStore } from "@/store/slices/openProjects";
import { requestTaskMonitorSnapshots, startTaskMonitorSync, useTaskMonitorStore } from "@/store/slices/taskMonitor";

export function TaskMonitorPopover() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const currentProject = useAppStore((s) => s.currentProject);
  const sessions = useAppStore((s) => s.sessions);
  const panes = useAppStore((s) => s.panesById);
  const tabs = useAppStore((s) => s.tabsById);
  const focusedTabId = useAppStore((s) => s.focusedTabId);
  const windows = useOpenProjectsStore((s) => s.windows);
  const refreshWindows = useOpenProjectsStore((s) => s.setOpenProjectWindows);
  const snapshots = useTaskMonitorStore((s) => s.snapshots);
  const projects = collectOpenProjects(windows, currentProject);

  useEffect(() => startTaskMonitorSync(), []);
  useEffect(() => {
    if (!open) return;
    const refresh = () => {
      void refreshWindows();
      void requestTaskMonitorSnapshots().catch((error) => console.error("Task monitor refresh failed:", error));
    };
    refresh();
    const interval = window.setInterval(refresh, 2000);
    return () => window.clearInterval(interval);
  }, [open, refreshWindows]);

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

  const content = (
    <div className="app-task-monitor">
      <div className="app-task-monitor-header">
        <span>{t("taskMonitor.title")}</span>
      </div>
      <div className="app-task-monitor-projects">
        {projects.length === 0 && <p className="app-task-monitor-empty">{t("taskMonitor.noProjects")}</p>}
        {projects.map((project) => {
          const key = projectPathKey(project.path);
          const isCurrent = !!currentProject && projectPathKey(currentProject.path) === key;
          const projectWindow = windows.find((item) => item.projectPath && projectPathKey(item.projectPath) === key);
          const snapshot = projectWindow ? snapshots[projectWindow.windowLabel] : undefined;
          const projectTabs = isCurrent ? collectTaskMonitorTabs(sessions, panes, tabs)
            : snapshot && projectPathKey(snapshot.projectPath) === key ? snapshot.tabs : null;
          return (
            <section key={key} className="app-task-monitor-project" aria-label={project.name}>
              <div className="app-task-monitor-project-name" title={project.path}>
                <FolderOpenOutlined />
                <span className="truncate">{project.name}</span>
              </div>
              {(!projectTabs || projectTabs.length === 0) && (
                <p className="app-task-monitor-empty">{t(projectTabs ? "taskMonitor.noTabs" : "taskMonitor.loading")}</p>
              )}
              {projectTabs?.map((tab) => (
                <button key={tab.id} type="button" className="app-task-monitor-row"
                  data-active={isCurrent && focusedTabId === tab.id ? "true" : "false"}
                  onClick={() => void navigate(project.path, tab)} title={tab.name}>
                  <span className="min-w-0 flex-1 truncate text-left">{tab.name}</span>
                  <Tooltip title={t(`taskMonitor.status.${tab.status}`)}>
                    <span className="app-task-monitor-dot" data-status={tab.status}
                      role="img" aria-label={t(`taskMonitor.status.${tab.status}`)} />
                  </Tooltip>
                </button>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="app-task-monitor-trigger-wrap">
      <Popover open={open} trigger={[]} placement="bottomRight" arrow={false} content={content}
        overlayClassName="app-task-monitor-popover">
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
