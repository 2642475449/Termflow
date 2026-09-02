import {
  BranchesOutlined,
  CheckOutlined,
  DeleteOutlined,
  DownOutlined,
  FolderOutlined,
  WarningOutlined,
  RightOutlined,
} from "@ant-design/icons";
import { Button, Checkbox, Modal, Popover, message } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectLauncher } from "@/hooks/useProjectLauncher";
import CloneRepositoryModal from "@/components/layout/CloneRepositoryModal";
import { useAppStore } from "@/store";
import { isSessionTurnRunning } from "@/lib/sessions";
import { focusExistingProjectWindow } from "@/lib/api";

const PROJECT_SWATCHES = ["#34d399", "#a78bfa", "#60a5fa", "#f59e0b", "#f472b6", "#22d3ee"];
const CURRENT_PROJECT_BACKGROUND =
  "color-mix(in srgb, var(--cs-primary) 8%, transparent)";

function getProjectInitial(name: string) {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 2).toUpperCase() : "?";
}

function getProjectSwatch(seed: string) {
  // FNV-1a distributes similar project paths better than a simple base-31
  // hash, whose modulo clustered paths with long shared Windows prefixes.
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  return PROJECT_SWATCHES[(hash >>> 0) % PROJECT_SWATCHES.length];
}

function TitleBarProjectSwitcher() {
  const { t } = useTranslation();
  const {
    currentProject,
    recentProjects,
    openProject,
    selectProjectFolder,
    removeRecentProject,
  } = useProjectLauncher();
  const upsertGitCloneTask = useAppStore((state) => state.upsertGitCloneTask);
  const projectOpenBehavior = useAppStore((state) => state.projectOpenBehavior);
  const setProjectOpenBehavior = useAppStore((state) => state.setProjectOpenBehavior);
  const [open, setOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [pendingProjectPath, setPendingProjectPath] = useState<string | null>(null);
  const [rememberOpenChoice, setRememberOpenChoice] = useState(false);

  const quickActions = [
    {
      key: "open-folder",
      icon: <FolderOutlined />,
      label: t("titleBar.projectSwitcherOpenAction"),
      onClick: async () => {
        const path = await selectProjectFolder();
        if (path) await requestProjectOpen(path);
      },
    },
    {
      key: "clone-repo",
      icon: <BranchesOutlined />,
      label: t("projectLauncher.cloneRepo"),
      onClick: async () => {
        setCloneOpen(true);
      },
    },
  ];

  async function handleQuickAction(action: (typeof quickActions)[number]) {
    setOpen(false);
    await waitForPopoverToClose();
    try {
      await action.onClick();
    } catch (error) {
      console.error(`Failed to run project switcher action ${action.key}:`, error);
      message.error(t("sidebar.projectWindowOpenFailed"));
    }
  }

  async function handleOpenRecentProject(path: string) {
    setOpen(false);
    await waitForPopoverToClose();
    await requestProjectOpen(path);
  }

  async function requestProjectOpen(path: string) {
    if (currentProject?.path === path) return;

    try {
      if (await focusExistingProjectWindow(path)) return;
    } catch (error) {
      console.error("Failed to focus existing project window:", error);
      message.error(t("sidebar.projectWindowOpenFailed"));
      return;
    }

    const state = useAppStore.getState();
    const hasRunningSessions = state.sessions.some(isSessionTurnRunning);
    const hasDirtyFiles = Object.values(state.tabsById).some((tab) => tab.dirty);
    if (
      projectOpenBehavior === "ask" ||
      (projectOpenBehavior === "current_window" && (hasRunningSessions || hasDirtyFiles))
    ) {
      setRememberOpenChoice(false);
      setPendingProjectPath(path);
      return;
    }

    try {
      await openProject(path, projectOpenBehavior);
    } catch (error) {
      console.error("Failed to open project window:", error);
      message.error(t("sidebar.projectWindowOpenFailed"));
    }
  }

  async function confirmProjectOpen(choice: "current_window" | "new_window") {
    const path = pendingProjectPath;
    if (!path) return;
    setPendingProjectPath(null);
    if (rememberOpenChoice) {
      setProjectOpenBehavior(choice);
    }
    try {
      await openProject(path, choice);
    } catch (error) {
      console.error("Failed to open project window:", error);
      message.error(t("sidebar.projectWindowOpenFailed"));
    }
  }

  useEffect(() => {
    if (!pendingProjectPath) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const key = event.key.toLowerCase();
      if (key === "t") {
        event.preventDefault();
        event.stopPropagation();
        void confirmProjectOpen("current_window");
      } else if (key === "w") {
        event.preventDefault();
        event.stopPropagation();
        void confirmProjectOpen("new_window");
      } else if (key === "d") {
        event.preventDefault();
        event.stopPropagation();
        setRememberOpenChoice((checked) => !checked);
      } else if (key === "enter") {
        event.preventDefault();
        event.stopPropagation();
        void confirmProjectOpen("current_window");
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [pendingProjectPath, rememberOpenChoice]);

  function handleRemoveRecentProject(path: string) {
    removeRecentProject(path);
  }

  const otherRecentProjects = recentProjects.filter(
    (project) => project.path !== currentProject?.path,
  );

  function renderProjectRow(
    project: { name: string; path: string },
    options: { current?: boolean; removable?: boolean } = {},
  ) {
    const projectSwatch = getProjectSwatch(project.path || project.name);
    return (
      <div
        key={project.path}
        className="group flex h-11 w-full shrink-0 items-center gap-2.5 rounded-[7px] px-2.5 text-left transition-colors"
        style={{
          color: "var(--cs-text-primary)",
          background: options.current ? CURRENT_PROJECT_BACKGROUND : "transparent",
        }}
        onMouseEnter={(event) => {
          if (!options.current) event.currentTarget.style.background = "var(--cs-bg-hover)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = options.current
            ? CURRENT_PROJECT_BACKGROUND
            : "transparent";
        }}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          onClick={() => {
            if (!options.current) void handleOpenRecentProject(project.path);
          }}
        >
          <div
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] border text-[11px] font-semibold"
            style={{
              background: `color-mix(in srgb, ${projectSwatch} 60%, var(--cs-bg-card, #ffffff))`,
              borderColor: `color-mix(in srgb, ${projectSwatch} 68%, transparent)`,
              color: "var(--cs-text-primary)",
            }}
          >
            {getProjectInitial(project.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-medium leading-4">{project.name}</div>
            <div
              className="truncate text-[10px] leading-[14px]"
              style={{ color: "var(--cs-text-tertiary)" }}
            >
              {project.path}
            </div>
          </div>
        </button>
        {options.current ? (
          <CheckOutlined
            className="mr-2 text-[12px]"
            style={{ color: "var(--cs-accent-primary)" }}
          />
        ) : null}
        {options.removable ? (
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] opacity-0 pointer-events-none transition-[opacity,background-color,color] group-hover:pointer-events-auto group-hover:opacity-100 focus:pointer-events-auto focus:opacity-100"
            aria-label={t("projectLauncher.removeRecentProject")}
            title={t("projectLauncher.removeRecentProject")}
            style={{ color: "var(--cs-text-tertiary)" }}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = "var(--cs-bg-hover)";
              event.currentTarget.style.color = "var(--cs-danger, #ef4444)";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = "transparent";
              event.currentTarget.style.color = "var(--cs-text-tertiary)";
            }}
            onClick={(event) => {
              event.stopPropagation();
              handleRemoveRecentProject(project.path);
            }}
          >
            <DeleteOutlined className="text-[13px]" />
          </button>
        ) : null}
      </div>
    );
  }

  const content = (
    <div
      className="w-[360px] max-w-[calc(100vw-16px)] overflow-hidden rounded-[12px] border"
      style={{
        background: "var(--cs-bg-card, var(--cs-bg-sidebar))",
        borderColor: "var(--cs-border-card, var(--cs-border-sidebar))",
        boxShadow: "0 14px 32px var(--cs-shadow-overlay)",
      }}
    >
      <div className="p-1.5">
        <div className="overflow-hidden rounded-[8px]">
          {quickActions.map((action) => (
            <button
              key={action.key}
              type="button"
              className="flex h-10 w-full items-center gap-2.5 rounded-[7px] px-2.5 text-left transition-colors"
              style={{
                color: "var(--cs-text-primary)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--cs-bg-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
              onClick={() => void handleQuickAction(action)}
            >
              <span className="text-[15px]" style={{ color: "var(--cs-text-secondary)" }}>
                {action.icon}
              </span>
              <span className="flex-1 text-[13px] font-medium">{action.label}</span>
              <RightOutlined
                className="text-[9px]"
                style={{ color: "var(--cs-text-tertiary)" }}
              />
            </button>
          ))}
        </div>
      </div>

      {currentProject ? (
        <div
          className="px-1.5 pb-1.5 pt-1.5"
          style={{ borderTop: "1px solid var(--cs-border-card, var(--cs-border-sidebar))" }}
        >
          <div
            className="px-2.5 pb-1.5 pt-0.5 text-[11px] font-medium"
            style={{ color: "var(--cs-text-secondary)" }}
          >
            {t("titleBar.projectSwitcherCurrentProject")}
          </div>
          {renderProjectRow(currentProject, { current: true })}
        </div>
      ) : null}

      <div
        className="px-1.5 pb-1.5 pt-1.5"
        style={{
          borderTop: "1px solid var(--cs-border-card, var(--cs-border-sidebar))",
        }}
      >
        <div
          className="px-2.5 pb-1.5 pt-0.5 text-[11px] font-medium"
          style={{ color: "var(--cs-text-secondary)" }}
        >
          {t("common.recent")}
        </div>

        {otherRecentProjects.length === 0 ? (
          <div
            className="px-2.5 py-3 text-[11px]"
            style={{ color: "var(--cs-text-tertiary)" }}
          >
            {t("projectLauncher.noRecentProjects")}
          </div>
        ) : (
          <div className="flex max-h-[min(308px,48vh)] flex-col overflow-y-auto pr-0.5">
            {otherRecentProjects.map((project) =>
              renderProjectRow(project, { removable: true }),
            )}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      <Popover
        trigger={["click"]}
        open={open}
        onOpenChange={setOpen}
        content={content}
        placement="bottomLeft"
        align={{ offset: [0, 6] }}
        arrow={false}
        overlayInnerStyle={{ padding: 0, background: "transparent", boxShadow: "none" }}
        styles={{ body: { padding: 0 } }}
        getPopupContainer={() => document.body}
      >
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex h-8 min-w-[124px] max-w-[196px] items-center gap-2 rounded-[6px] px-2 text-left transition-colors"
          style={{
            background: open ? "var(--cs-bg-hover)" : "transparent",
          }}
        >
          {currentProject ? (
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-[12px] font-semibold leading-none"
              style={{
                background: getProjectSwatch(currentProject.path || currentProject.name),
                color: "#0b0f14",
              }}
              aria-hidden="true"
            >
              {getProjectInitial(currentProject.name)}
            </span>
          ) : null}
          <span
            className="min-w-0 flex-1 truncate text-[12px] font-medium"
            style={{ color: "var(--cs-text-primary)" }}
          >
            {currentProject?.name ?? t("titleBar.projectSwitcherPlaceholder")}
          </span>
          <DownOutlined
            className="text-[10px]"
            style={{ color: "var(--cs-text-tertiary)" }}
          />
        </button>
      </Popover>
      <CloneRepositoryModal
        open={cloneOpen}
        onCancel={() => setCloneOpen(false)}
        onCloneStarted={(task) => {
          upsertGitCloneTask({
            taskId: task.taskId,
            status: "starting",
            projectPath: task.projectPath,
            directoryName: task.directoryName,
            remoteUrl: "",
            stage: null,
            progressPercent: null,
            current: null,
            total: null,
            transferred: null,
            speed: null,
            detail: null,
            error: null,
          });
          setCloneOpen(false);
          message.success(t("projectLauncher.cloneStartedInBackground", { name: task.directoryName }));
        }}
      />
      <Modal
        open={pendingProjectPath !== null}
        title={t("projectLauncher.openProjectTitle")}
        centered
        width={520}
        destroyOnHidden
        onCancel={() => setPendingProjectPath(null)}
        footer={
          <div className="flex justify-end gap-2">
            <Button autoFocus type="primary" onClick={() => void confirmProjectOpen("current_window")}>
              {t("projectLauncher.openInCurrentWindow")}
            </Button>
            <Button onClick={() => void confirmProjectOpen("new_window")}>
              {t("projectLauncher.openInNewWindow")}
            </Button>
            <Button onClick={() => setPendingProjectPath(null)}>{t("common.cancel")}</Button>
          </div>
        }
      >
        <div className="pt-1">
          <div>
            {t("projectLauncher.openProjectQuestion", {
              name: pendingProjectPath?.split(/[\\/]/).pop() || pendingProjectPath || "",
            })}
          </div>
          <ProjectOpenWarnings />
          <Checkbox
            className="mt-4"
            checked={rememberOpenChoice}
            onChange={(event) => setRememberOpenChoice(event.target.checked)}
          >
            {t("projectLauncher.rememberOpenChoice")}
          </Checkbox>
        </div>
      </Modal>
    </>
  );
}

function ProjectOpenWarnings() {
  const { t } = useTranslation();
  const runningSessionCount = useAppStore((state) =>
    state.sessions.filter(isSessionTurnRunning).length
  );
  const dirtyFileCount = useAppStore((state) => Object.values(state.tabsById).filter(
    (tab) => tab.dirty
  ).length);
  if (runningSessionCount === 0 && dirtyFileCount === 0) return null;
  return (
    <div className="mt-3 flex items-start gap-2.5 text-xs leading-5">
      <WarningOutlined
        className="mt-[3px] shrink-0"
        style={{ color: "var(--cs-warning)" }}
      />
      <div className="min-w-0">
        <div style={{ color: "var(--cs-text-secondary)" }}>
          {runningSessionCount > 0 ? (
            <div>{t("projectLauncher.openProjectRunningSessions", { count: runningSessionCount })}</div>
          ) : null}
          {dirtyFileCount > 0 ? (
            <div>{t("projectLauncher.openProjectUnsavedFiles", { count: dirtyFileCount })}</div>
          ) : null}
        </div>
        <div className="mt-0.5" style={{ color: "var(--cs-warning)" }}>
          {t("projectLauncher.currentWindowCleanupWarning")}
        </div>
      </div>
    </div>
  );
}

function waitForPopoverToClose() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

export default TitleBarProjectSwitcher;
