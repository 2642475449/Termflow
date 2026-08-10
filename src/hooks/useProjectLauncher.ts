import { useCallback, useEffect, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { message } from "antd";
import { useTranslation } from "react-i18next";
import { getExistingProjectPaths, openProjectWindow } from "@/lib/api";
import { useAppStore } from "@/store";
import { broadcastRecentProjectOpened } from "@/hooks/useRecentProjectSync";

function sortRecentProjects<T extends { lastOpenedAt: number }>(items: T[]) {
  return [...items].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export function useProjectLauncher() {
  const { t } = useTranslation();
  const currentProject = useAppStore((s) => s.currentProject);
  const windowLabel = useAppStore((s) => s.windowLabel);
  const windowMode = useAppStore((s) => s.windowMode);
  const recentProjectsState = useAppStore((s) => s.recentProjects);
  const initializeWindowContext = useAppStore((s) => s.initializeWindowContext);
  const setRecentProjects = useAppStore((s) => s.setRecentProjects);

  const recentProjects = useMemo(
    () => sortRecentProjects(recentProjectsState).slice(0, 10),
    [recentProjectsState]
  );

  const openProject = useCallback(
    async (path: string) => {
      const launchedFromLauncher = windowMode === "launcher";
      const context = await openProjectWindow(path, launchedFromLauncher);
      const projectPath = context.projectPath || path;
      await broadcastRecentProjectOpened({
        path: projectPath,
        name: context.projectName || projectPath.split(/[\\/]/).pop() || projectPath,
      });

      if (context.windowLabel === windowLabel) {
        initializeWindowContext(context);
        return;
      }

      if (launchedFromLauncher) {
        await getCurrentWindow().close().catch(() => {});
      }
    },
    [initializeWindowContext, windowLabel, windowMode]
  );

  const handleOpenFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("sidebar.selectProjectTitle"),
    });

    if (!selected) return;

    const path = selected as string;
    await openProject(path).catch((error) => {
      console.error("Failed to open project window:", error);
      message.error(t("sidebar.projectWindowOpenFailed"));
    });
  }, [openProject, t]);

  const removeRecentProject = useCallback(
    (path: string) => {
      setRecentProjects(recentProjectsState.filter((project) => project.path !== path));
    },
    [recentProjectsState, setRecentProjects]
  );

  useEffect(() => {
    if (recentProjectsState.length === 0) return;

    let cancelled = false;
    const paths = recentProjectsState.map((item) => item.path);

    void getExistingProjectPaths(paths)
      .then((existingPaths) => {
        if (cancelled) return;
        const existingPathSet = new Set(existingPaths);
        if (existingPathSet.size === paths.length) return;

        setRecentProjects(
          recentProjectsState.filter((item) => existingPathSet.has(item.path))
        );
      })
      .catch(() => {
        // Ignore cleanup failures so the launcher never blocks.
      });

    return () => {
      cancelled = true;
    };
  }, [recentProjectsState, setRecentProjects]);

  return {
    currentProject,
    recentProjects,
    openProject,
    handleOpenFolder,
    removeRecentProject,
  };
}
