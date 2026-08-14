import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Layout, Button, message, Modal, Input, Tooltip } from "antd";
import type { MenuProps } from "antd";
import {
  PlusOutlined,
  EditOutlined,
  EnterOutlined,
  CopyOutlined,
  FolderOpenFilled,
  PushpinOutlined,
  PushpinFilled,
  InboxOutlined,
  CheckOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { useAppStore, type SidebarSection } from "@/store";
import {
  gitBranchInfo,
  gitRepoInfo,
  gitStatus,
  openInFileManager,
  openInAssociatedApplication,
} from "@/lib/api";
import { archiveSessionRuntime } from "@/lib/tabClose";
import { isSessionVisibleInHistory } from "@/lib/sessions";
import { openCheckpointReview } from "@/lib/checkpointReview";
import { openAuxiliarySession } from "@/lib/auxiliaryDock";
import { useTranslation } from "react-i18next";
import type { Session } from "@/types";
import { useResumeSession } from "@/hooks/useResumeSession";
import SidebarProjectPanel from "./sidebar/SidebarProjectPanel";
import SidebarSessionsPanel from "./sidebar/SidebarSessionsPanel";
import SidebarGitPanel from "./sidebar/SidebarGitPanel";
import { useGitRefreshController } from "@/hooks/useGitRefreshController";
import { useGitFileWatcher } from "@/hooks/useGitFileWatcher";
import { GIT_REFRESH_EVENT, publishGitStatusSnapshot } from "@/lib/gitStatusEvents";

const { Sider } = Layout;
const TERMINAL_LAYOUT_SYNC_EVENT = "terminal:layout-sync";
const DEFAULT_SIDEBAR_WIDTH = 248;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 360;
const RESIZE_HANDLE_WIDTH = 6;

interface SidebarProps {
  collapsed: boolean;
  section: SidebarSection;
}

function Sidebar({ collapsed, section }: SidebarProps) {
  const { t, i18n } = useTranslation();
  const currentProject = useAppStore((s) => s.currentProject);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const resumeSession = useResumeSession();
  const openTab = useAppStore((s) => s.openTab);
  const openFileTab = useAppStore((s) => s.openFileTab);
  const updateSession = useAppStore((s) => s.updateSession);
  const togglePinSession = useAppStore((s) => s.togglePinSession);
  const archiveSession = useAppStore((s) => s.archiveSession);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const gitRefreshSequenceRef = useRef(0);
  const archivingSessionIdsRef = useRef(new Set<string>());
  const activeProjectPathRef = useRef(currentProject?.path ?? null);
  activeProjectPathRef.current = currentProject?.path ?? null;
  const setGitChangeCount = useAppStore((s) => s.setGitChangeCount);
  const setGitSyncCounts = useAppStore((s) => s.setGitSyncCounts);
  const pinnedCollapsed = useAppStore((s) => s.sidebarPinnedCollapsed);
  const sessionsCollapsed = useAppStore((s) => s.sidebarSessionsCollapsed);
  const togglePinnedCollapsed = useAppStore((s) => s.togglePinnedCollapsed);
  const toggleSessionsCollapsed = useAppStore((s) => s.toggleSessionsCollapsed);
  const projectAttentionItems = useAppStore((s) => s.projectAttentionItems);
  const resolveAttentionForSession = useAppStore((s) => s.resolveAttentionForSession);

  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renamingSession, setRenamingSession] = useState<{ id: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isResizing, setIsResizing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Refresh relative time every 60 seconds
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const refreshGitBadgeCount = useCallback(async () => {
    const requestId = ++gitRefreshSequenceRef.current;
    if (!currentProject) {
      setGitChangeCount(0);
      setGitSyncCounts(0, 0);
      return;
    }

    const projectPath = currentProject.path;
    const isCurrentRequest = () =>
      gitRefreshSequenceRef.current === requestId && activeProjectPathRef.current === projectPath;

    try {
      const repoInfo = await gitRepoInfo(projectPath);
      if (!isCurrentRequest()) return;
      if (!repoInfo.isRepo) {
        setGitChangeCount(0);
        setGitSyncCounts(0, 0);
        publishGitStatusSnapshot({
          projectPath,
          isRepo: false,
          statuses: [],
          branch: null,
        });
        return;
      }

      const [statuses, branch] = await Promise.all([
        gitStatus(projectPath),
        gitBranchInfo(projectPath).catch(() => null),
      ]);
      if (!isCurrentRequest()) return;
      setGitChangeCount(statuses.length);
      setGitSyncCounts(branch?.ahead ?? 0, branch?.behind ?? 0);
      publishGitStatusSnapshot({
        projectPath,
        isRepo: true,
        statuses,
        branch,
      });
    } catch {
      if (!isCurrentRequest()) return;
      setGitChangeCount(0);
      setGitSyncCounts(0, 0);
    }
  }, [currentProject, setGitChangeCount, setGitSyncCounts]);

  // 使用 Git 刷新控制器（防抖 + 冷却 + 操作保护）
  const { requestRefresh, refreshNow, markOperationStart, markOperationEnd } = useGitRefreshController(
    refreshGitBadgeCount,
    { debounceDelay: 1000, cooldownDelay: 5000, pollingInterval: 30000 }
  );

  // 使用文件系统监听（事件驱动，替代轮询）
  useGitFileWatcher(
    currentProject?.path ?? null,
    requestRefresh,
    !!currentProject
  );

  // 将控制器方法暴露到全局，供 Git 操作使用
  useEffect(() => {
    // 存储到 window 上，供 useGitCommit 等 hook 使用
    (window as unknown as Record<string, unknown>).__gitRefreshController = {
      requestRefresh,
      refreshNow,
      markOperationStart,
      markOperationEnd,
    };

    return () => {
      delete (window as unknown as Record<string, unknown>).__gitRefreshController;
    };
  }, [requestRefresh, refreshNow, markOperationStart, markOperationEnd]);

  // 监听 git-refresh 自定义事件（文件保存时触发）
  useEffect(() => {
    const handleGitRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ projectPath?: string }>).detail;
      if (!detail?.projectPath || detail.projectPath === currentProject?.path) {
        requestRefresh();
      }
    };

    window.addEventListener(GIT_REFRESH_EVENT, handleGitRefresh as EventListener);
    return () => {
      window.removeEventListener(GIT_REFRESH_EVENT, handleGitRefresh as EventListener);
    };
  }, [currentProject?.path, requestRefresh]);

  // Keep `now` referenced to trigger re-renders for relative time updates
  void now;
  async function handleSessionClick(sessionId: string) {
    const session = sessions.find((s) => s.id === sessionId);
    if (session?.presentation === "auxiliary") {
      openAuxiliarySession({
        sessionId: session.id,
        projectPath: session.path,
        title: session.name,
        kind: session.ephemeral ? "terminal" : "task",
      });
    } else {
      openTab(sessionId);
    }
    if (session?.status === "starting") {
      return;
    }
    if (session && !session.active) {
      await resumeSession(sessionId);
    }
  }

  function handleOpenRename(sessionId: string, currentName: string) {
    setRenamingSession({ id: sessionId, name: currentName });
    setRenameValue(currentName);
    setRenameModalOpen(true);
  }

  function handleConfirmRename() {
    if (!renamingSession || !renameValue.trim()) return;
    updateSession(renamingSession.id, {
      name: renameValue.trim(),
      titleSource: "manual",
    });
    setRenameModalOpen(false);
    setRenamingSession(null);
    message.success(t("sidebar.sessionRenamed"));
  }

  function getSessionMenuItems(session: Session): MenuProps["items"] {
    const isActive = activeSessionId === session.id;
    const isPinned = session.pinned;
    const openAttention = currentProject
      ? (projectAttentionItems[currentProject.path] ?? []).find(
          (item) => item.sessionId === session.id && item.disposition === "open"
        )
      : undefined;
    const items: MenuProps["items"] = [
      ...((session.checkpointPendingTurns ?? 0) > 0 ||
      Boolean(session.checkpointActiveTurnId) ||
      Boolean(session.checkpointUpdatedAt)
        ? [
            {
              key: "checkpoint-review",
              label: t("checkpointReview.open"),
              icon: <SafetyCertificateOutlined />,
              onClick: () => openCheckpointReview(session.id),
            },
            { type: "divider" as const },
          ]
        : []),
      ...(openAttention?.kind === "failure"
        ? [
            {
              key: "resolve-attention",
              label: t("sidebar.attentionResolveFailure"),
              icon: <CheckOutlined />,
              onClick: () => resolveAttentionForSession(session.id, "handled-by-user"),
            },
            { type: "divider" as const },
          ]
        : []),
      {
        key: "open",
        label: t("sidebar.openSession"),
        icon: <EnterOutlined />,
        disabled: isActive,
        onClick: () => handleSessionClick(session.id),
      },
      {
        key: "rename",
        label: t("sidebar.renameSession"),
        icon: <EditOutlined />,
        onClick: () => handleOpenRename(session.id, session.name),
      },
      {
        key: "pin",
        label: isPinned ? t("sidebar.unpinSession") : t("sidebar.pinSession"),
        icon: isPinned ? <PushpinFilled /> : <PushpinOutlined />,
        onClick: () => {
          togglePinSession(session.id);
          message.success(isPinned ? t("sidebar.sessionUnpinned") : t("sidebar.sessionPinned"));
        },
      },
      {
        key: "archive",
        label: t("sidebar.archiveSession"),
        icon: <InboxOutlined />,
        onClick: () => void handleArchiveSession(session.id),
      },
      { type: "divider" },
      {
        key: "open-folder",
        label: t("common.openInFileManager"),
        icon: <FolderOpenFilled />,
        onClick: () => openInFileManager(session.path).catch(() => message.error(t("sidebar.openFolderFailed"))),
      },
      {
        key: "copy-path",
        label: t("common.copyPath"),
        icon: <CopyOutlined />,
        onClick: () => navigator.clipboard.writeText(session.path).then(() => message.success(t("sidebar.copyPathSuccess"))),
      },
    ];
    return items;
  }

  async function handleArchiveSession(sessionId: string) {
    if (archivingSessionIdsRef.current.has(sessionId)) return;
    archivingSessionIdsRef.current.add(sessionId);
    try {
      await archiveSessionRuntime(sessionId, archiveSession);
      message.success(t("sidebar.sessionArchived"));
    } catch (error) {
      console.error("Failed to stop and archive session:", error);
      message.error(t("sidebar.sessionArchiveFailed"));
    } finally {
      archivingSessionIdsRef.current.delete(sessionId);
    }
  }

  function handleOpenPathInManager(path: string) {
    openInFileManager(path).catch(() => message.error(t("sidebar.openFolderFailed")));
  }

  function handleOpenPathInAssociatedApp(path: string) {
    openInAssociatedApplication(path).catch(() => message.error(t("sidebar.openAssociatedAppFailed")));
  }

  function handleOpenFile(path: string, options?: { preview?: boolean }) {
    openFileTab(path, { preview: options?.preview ?? true });
  }

  const syncActiveTerminalLayout = useCallback(() => {
    const state = useAppStore.getState();
    const activeTabId = state.activeSessionId;
    if (!activeTabId || state.tabsById[activeTabId]?.kind !== "session") return;
    window.dispatchEvent(
      new CustomEvent(TERMINAL_LAYOUT_SYNC_EVENT, {
        detail: {
          sessionId: activeTabId,
          reason: "sidebar-resized",
        },
      })
    );
  }, []);

  const handleResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (collapsed) return;

      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sidebarWidth || DEFAULT_SIDEBAR_WIDTH;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      let frameId = 0;

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      setIsResizing(true);

      const onPointerMove = (moveEvent: PointerEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const nextWidth = Math.min(
          MAX_SIDEBAR_WIDTH,
          Math.max(MIN_SIDEBAR_WIDTH, startWidth + deltaX)
        );

        if (frameId) cancelAnimationFrame(frameId);
        frameId = requestAnimationFrame(() => {
          setSidebarWidth(nextWidth);
          syncActiveTerminalLayout();
        });
      };

      const stopResizing = () => {
        if (frameId) cancelAnimationFrame(frameId);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        setIsResizing(false);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", stopResizing);
        window.removeEventListener("pointercancel", stopResizing);
        syncActiveTerminalLayout();
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", stopResizing);
      window.addEventListener("pointercancel", stopResizing);
    },
    [collapsed, setSidebarWidth, sidebarWidth, syncActiveTerminalLayout]
  );

  const effectiveSidebarWidth = Math.min(
    MAX_SIDEBAR_WIDTH,
    Math.max(MIN_SIDEBAR_WIDTH, sidebarWidth || DEFAULT_SIDEBAR_WIDTH)
  );
  const shellWidth = collapsed ? 0 : effectiveSidebarWidth + RESIZE_HANDLE_WIDTH;

  return (
    <div
      className="app-shell-chrome app-sidebar-frame"
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "stretch",
        width: shellWidth,
        minWidth: shellWidth,
        maxWidth: shellWidth,
        overflow: "hidden",
        opacity: collapsed ? 0 : 1,
        transition: isResizing
          ? "opacity 120ms ease"
          : "width 200ms ease, min-width 200ms ease, max-width 200ms ease, opacity 120ms ease",
      }}
    >
      <Sider
        width={effectiveSidebarWidth}
        className="app-glass-sidebar flex flex-col h-full"
        style={{
          width: effectiveSidebarWidth,
          minWidth: effectiveSidebarWidth,
          maxWidth: effectiveSidebarWidth,
          background: "transparent",
          borderRight: "none",
          pointerEvents: collapsed ? "none" : "auto",
        }}
      >
        <div className="app-sidebar-surface flex min-h-0 flex-1 flex-col">
          {section === "sessions" && currentProject && (
            <div
              className="px-3 pt-2.5 pb-2"
              style={{ borderBottom: "1px solid color-mix(in srgb, var(--cs-border-sidebar) 88%, transparent)" }}
            >
              <Tooltip title={t("sidebar.newSessionTooltip")} mouseEnterDelay={0.4}>
                <Button
                  type="default"
                  icon={<PlusOutlined />}
                  block
                  onClick={() => window.dispatchEvent(new CustomEvent("shortcut:new-session"))}
                  style={{
                    height: 34,
                    borderRadius: 8,
                    borderColor: "color-mix(in srgb, var(--cs-primary) 24%, var(--cs-border-sidebar) 76%)",
                    background: "color-mix(in srgb, var(--cs-primary) 7%, var(--cs-bg-sidebar) 93%)",
                    color: "color-mix(in srgb, var(--cs-primary) 74%, var(--cs-text-primary) 26%)",
                    fontWeight: 600,
                    boxShadow: "none",
                  }}
                >
                  {t("sidebar.newSession")}
                </Button>
              </Tooltip>
            </div>
          )}

          <div className={section === "project" ? "flex-1 min-h-0 overflow-hidden p-3" : "flex-1 min-h-0 overflow-y-auto app-project-tree-scroll p-2.5"}>
            {section === "project" ? (
              <SidebarProjectPanel
                currentProject={currentProject}
                noProjectText={t("sidebar.noProject")}
                panelTitle={t("common.file")}
                filterPlaceholderText={t("sidebar.fileFilterPlaceholder")}
                filterNoResultsText={t("sidebar.fileFilterNoResults")}
                openInManagerText={t("common.openInFileManager")}
                openInAssociatedAppText={t("common.openInAssociatedApp")}
                copyRelativePathText={t("sidebar.copyRelativePath")}
                copyAbsolutePathText={t("sidebar.copyAbsolutePath")}
                copyPathSuccessText={t("sidebar.copyPathSuccess")}
                refreshText={t("common.refresh")}
                loadingText={t("sidebar.filePanelLoading")}
                emptyFolderText={t("sidebar.filePanelEmpty")}
                onOpenInFileManager={handleOpenPathInManager}
                onOpenInAssociatedApp={handleOpenPathInAssociatedApp}
                onOpenFile={handleOpenFile}
              />
            ) : section === "git" ? (
              <SidebarGitPanel
                currentProject={currentProject}
              />
            ) : (
              <SidebarSessionsPanel
                currentProject={currentProject}
                sessions={sessions.filter(isSessionVisibleInHistory)}
                attentionItems={currentProject ? projectAttentionItems[currentProject.path] ?? [] : []}
                activeSessionId={activeSessionId}
                locale={i18n.language}
                noProjectText={t("sidebar.noProject")}
                noSessionsText={t("sidebar.noSessions")}
                archiveSessionText={t("sidebar.archiveSession")}
                pinSessionText={t("sidebar.pinSession")}
                unpinSessionText={t("sidebar.unpinSession")}
                pinnedSectionText={t("sidebar.pinnedSection")}
                sessionsSectionText={t("sidebar.sessionsSection")}
                pinnedCollapsed={pinnedCollapsed}
                sessionsCollapsed={sessionsCollapsed}
                onTogglePinned={togglePinnedCollapsed}
                onToggleSessions={toggleSessionsCollapsed}
                onOpenSession={handleSessionClick}
                onArchiveSession={handleArchiveSession}
                onTogglePinSession={togglePinSession}
                onOpenCheckpointReview={openCheckpointReview}
                getSessionMenuItems={getSessionMenuItems}
              />
            )}
          </div>
        </div>
      </Sider>
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("sidebar.resizeHandle", "Resize sidebar")}
          className="app-sidebar-resize-handle"
          onPointerDown={handleResizeStart}
          style={{
            width: RESIZE_HANDLE_WIDTH,
            minWidth: RESIZE_HANDLE_WIDTH,
            cursor: "col-resize",
            touchAction: "none",
            background: isResizing
              ? "color-mix(in srgb, var(--cs-primary) 10%, transparent)"
              : "transparent",
            borderRight: "1px solid transparent",
          }}
        />
      )}

      <Modal
        title={t("sidebar.renameSessionTitle")}
        open={renameModalOpen}
        onOk={handleConfirmRename}
        onCancel={() => setRenameModalOpen(false)}
        okText={t("common.confirm")}
        cancelText={t("common.cancel")}
        destroyOnClose
      >
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onPressEnter={handleConfirmRename}
          placeholder={t("sidebar.sessionNamePlaceholder")}
          autoFocus
        />
      </Modal>
    </div>
  );
}

export default Sidebar;
