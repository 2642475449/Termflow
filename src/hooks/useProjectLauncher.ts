import { useCallback, useEffect, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { message } from "antd";
import { useTranslation } from "react-i18next";
import { getExistingProjectPaths, openProjectWindow } from "@/lib/api";
import type { ProjectOpenDisposition } from "@/types";
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
    async (path: string, requestedDisposition?: ProjectOpenDisposition) => {
      const launchedFromLauncher = windowMode === "launcher";
      const disposition: ProjectOpenDisposition = requestedDisposition ?? "auto";

      const previousProjectPath = currentProject?.path ?? null;
      const context = await openProjectWindow(path, disposition);
      if (
        disposition === "current_window" &&
        previousProjectPath &&
        context.projectPath !== previousProjectPath
      ) {
        useAppStore.setState((state) => {
          const { [previousProjectPath]: _discardedWorkspace, ...remainingWorkspaces } =
            state.projectWorkspaces;
          return {
            projectSessions: {
              ...state.projectSessions,
              [previousProjectPath]: (state.projectSessions[previousProjectPath] ?? []).map(
                (session) => ({
                  ...session,
                  active: false,
                  status: session.active || session.status === "starting" || session.status === "running"
                    ? "stopped" as const
                    : session.status,
                })
              ),
            },
            projectWorkspaces: remainingWorkspaces,
            fileDocuments: {},
            gitDiffDocuments: {},
          };
        });
      }
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
    [currentProject?.path, initializeWindowContext, windowLabel, windowMode]
  );

  const selectProjectFolder = useCallback(async (): Promise<string | null> => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("sidebar.selectProjectTitle"),
    });

    return selected ? selected as string : null;
  }, [t]);

  const handleOpenFolder = useCallback(async () => {
    const path = await selectProjectFolder();
    if (!path) return;
    await openProject(path).catch((error) => {
      console.error("Failed to open project window:", error);
      message.error(t("sidebar.projectWindowOpenFailed"));
    });
  }, [openProject, selectProjectFolder, t]);

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
    selectProjectFolder,
    handleOpenFolder,
    removeRecentProject,
  };
}
