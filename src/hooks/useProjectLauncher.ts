import { createElement, useCallback, useEffect, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Checkbox, Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import { getExistingProjectPaths, isProjectWindowOpen, openProjectWindow } from "@/lib/api";
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
  const projectOpenBehavior = useAppStore((s) => s.projectOpenBehavior);
  const setProjectOpenBehavior = useAppStore((s) => s.setProjectOpenBehavior);
  const initializeWindowContext = useAppStore((s) => s.initializeWindowContext);
  const setRecentProjects = useAppStore((s) => s.setRecentProjects);

  const recentProjects = useMemo(
    () => sortRecentProjects(recentProjectsState).slice(0, 10),
    [recentProjectsState]
  );

  const openProject = useCallback(
    async (path: string) => {
      const launchedFromLauncher = windowMode === "launcher";
      let disposition: ProjectOpenDisposition = "auto";

      if (!launchedFromLauncher && currentProject?.path !== path) {
        const alreadyOpen = await isProjectWindowOpen(path);
        if (!alreadyOpen) {
          const state = useAppStore.getState();
          const runningSessionCount = state.sessions.filter((session) =>
            session.active || session.status === "starting" || session.status === "running"
          ).length;
          const dirtyFileCount = Object.values(state.tabsById).filter((tab) => tab.dirty).length;
          const mustConfirmCurrentWindow =
            projectOpenBehavior === "current_window" &&
            (runningSessionCount > 0 || dirtyFileCount > 0);
          const selectedDisposition = projectOpenBehavior === "ask" || mustConfirmCurrentWindow
            ? await askProjectOpenDisposition({
                projectName: path.split(/[\\/]/).pop() || path,
                runningSessionCount,
                dirtyFileCount,
                t,
                onRemember: setProjectOpenBehavior,
              })
            : projectOpenBehavior;
          if (!selectedDisposition) return;
          disposition = selectedDisposition;
        } else {
          disposition = "new_window";
        }
      }

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
    [currentProject?.path, initializeWindowContext, projectOpenBehavior, setProjectOpenBehavior, t, windowLabel, windowMode]
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

function askProjectOpenDisposition({
  projectName,
  runningSessionCount,
  dirtyFileCount,
  t,
  onRemember,
}: {
  projectName: string;
  runningSessionCount: number;
  dirtyFileCount: number;
  t: (key: string, options?: Record<string, unknown>) => string;
  onRemember: (behavior: "current_window" | "new_window") => void;
}): Promise<"current_window" | "new_window" | null> {
  return new Promise((resolve) => {
    let remember = false;
    let settled = false;
    const finish = (choice: "current_window" | "new_window") => {
      if (settled) return;
      settled = true;
      if (remember) onRemember(choice);
      modal.destroy();
      resolve(choice);
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      modal.destroy();
      resolve(null);
    };
    const warnings = [
      runningSessionCount > 0
        ? t("projectLauncher.openProjectRunningSessions", { count: runningSessionCount })
        : null,
      dirtyFileCount > 0
        ? t("projectLauncher.openProjectUnsavedFiles", { count: dirtyFileCount })
        : null,
    ].filter(Boolean);
    const modal = Modal.confirm({
      title: t("projectLauncher.openProjectTitle"),
      icon: null,
      closable: true,
      centered: true,
      width: 520,
      content: createElement("div", { className: "pt-1" },
        createElement("div", null, t("projectLauncher.openProjectQuestion", { name: projectName })),
        warnings.length > 0
          ? createElement("div", {
              className: "mt-3 rounded-md px-3 py-2 text-xs",
              style: { background: "var(--cs-bg-hover)", color: "var(--cs-warning)" },
            },
            ...warnings.map((warning) => createElement("div", { key: warning }, warning)),
            createElement("div", null, t("projectLauncher.currentWindowCleanupWarning")))
          : null,
        createElement(Checkbox, {
          className: "mt-4",
          onChange: (event) => { remember = event.target.checked; },
        }, t("projectLauncher.rememberOpenChoice"))
      ),
      onCancel: cancel,
      footer: () => createElement("div", { className: "flex justify-end gap-2" },
        createElement(Button, { onClick: cancel }, t("common.cancel")),
        createElement(Button, { onClick: () => finish("current_window") }, t("projectLauncher.openInCurrentWindow")),
        createElement(Button, { type: "primary", onClick: () => finish("new_window") }, t("projectLauncher.openInNewWindow")),
      ),
    });
  });
}
