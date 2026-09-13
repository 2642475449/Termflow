import { AppstoreOutlined, ClockCircleOutlined, FolderOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useScheduledTaskStore } from "@/store/slices/scheduledTasks";

interface SidebarScheduledTasksPanelProps {
  currentProject: { path: string; name: string } | null;
}

export default function SidebarScheduledTasksPanel({
  currentProject,
}: SidebarScheduledTasksPanelProps) {
  const { t } = useTranslation();
  const tasks = useScheduledTaskStore((state) => state.tasks);
  const scope = useScheduledTaskStore((state) => state.scope);
  const setScope = useScheduledTaskStore((state) => state.setScope);
  const currentProjectCount = currentProject
    ? tasks.filter((task) => task.projectPath === currentProject.path).length
    : 0;
  const projectEntries = Array.from(
    tasks.reduce((entries, task) => {
      const entry = entries.get(task.projectPath) ?? {
        path: task.projectPath,
        name: task.projectName,
        count: 0,
      };
      entry.count += 1;
      entries.set(task.projectPath, entry);
      return entries;
    }, new Map<string, { path: string; name: string; count: number }>()).values(),
  );
  if (currentProject && !projectEntries.some((entry) => entry.path === currentProject.path)) {
    projectEntries.unshift({ ...currentProject, count: 0 });
  }

  return (
    <div className="app-scheduled-sidebar flex h-full min-h-0 flex-col p-2.5">
      <div className="app-scheduled-sidebar-title px-2.5 pb-3 pt-1 text-sm font-semibold">
        <ClockCircleOutlined />
        <span>{t("scheduledTasks.title")}</span>
      </div>
      <nav className="flex flex-col gap-1" aria-label={t("scheduledTasks.sidebarNavLabel")}>
        <button
          type="button"
          data-active={scope === "current"}
          className="app-scheduled-sidebar-item"
          onClick={() => setScope("current")}
        >
          <ClockCircleOutlined />
          <span>{t("scheduledTasks.currentProject")}</span>
          <span className="app-scheduled-sidebar-count">{currentProjectCount}</span>
        </button>
        <button
          type="button"
          data-active={scope === "all"}
          className="app-scheduled-sidebar-item"
          onClick={() => setScope("all")}
        >
          <AppstoreOutlined />
          <span>{t("scheduledTasks.allProjects")}</span>
          <span className="app-scheduled-sidebar-count">{tasks.length}</span>
        </button>
      </nav>
      <div className="app-scheduled-sidebar-label px-2.5 pt-7 text-xs">
        {t("scheduledTasks.projects")}
      </div>
      <div className="mt-1 flex min-h-0 flex-col gap-1 overflow-y-auto">
        {projectEntries.map((project) => (
          <button
            key={project.path}
            type="button"
            data-active={scope === project.path}
            className="app-scheduled-sidebar-item"
            title={project.path}
            onClick={() => setScope(project.path)}
          >
            <FolderOutlined />
            <span className="min-w-0 flex-1 truncate text-left">{project.name}</span>
            <span className="app-scheduled-sidebar-count">{project.count}</span>
          </button>
        ))}
      </div>
      <div className="app-scheduled-sidebar-status mt-4 px-2.5 pt-3 text-xs">
        <span aria-hidden="true">●</span>
        <div>
          <div>{t("scheduledTasks.schedulerRunning")}</div>
          <div className="mt-1 text-[11px]">{t("scheduledTasks.appRunHint")}</div>
        </div>
      </div>
    </div>
  );
}
