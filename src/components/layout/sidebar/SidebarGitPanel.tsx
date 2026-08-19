import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Dropdown, Input, message, Modal, Tooltip } from "antd";
import type { MenuProps } from "antd";
import {
  BranchesOutlined,
  CheckOutlined,
  DownOutlined,
  EllipsisOutlined,
  LinkOutlined,
  LoadingOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import {
  gitDiffContent,
  gitAddRemoteAndPush,
  gitGenerateCommitMessage,
  gitDiscardChanges,
  gitStageFiles,
  gitUnstageFiles,
  openInFileManager,
} from "@/lib/api";
import { revealExplorerPath } from "@/lib/explorer";
import {
  GIT_FILE_HISTORY_OPEN_EVENT,
  takePendingGitFileHistoryOpen,
  type GitFileHistoryOpenDetail,
} from "@/lib/gitGraphEvents";
import { useAppStore } from "@/store";
import { useGitStatus } from "@/hooks/useGitStatus";
import { useGitCommit } from "@/hooks/useGitCommit";
import type { GitFileStatus } from "@/types";
import { useTranslation } from "react-i18next";
import { GitCommitComposer } from "./GitCommitComposer";
import { GitFileList } from "./GitFileList";
import { GitGraphSection } from "./GitGraphSection";
import { GitBranchPanel } from "./GitBranchPanel";
import { GitConflictPanel } from "./GitConflictPanel";

/**
 * 获取全局 Git 刷新控制器
 */
function getGitRefreshController() {
  return (window as unknown as Record<string, unknown>).__gitRefreshController as {
    requestRefresh: () => void;
    refreshNow: () => void;
    markOperationStart: () => void;
    markOperationEnd: () => void;
  } | undefined;
}

interface SidebarGitPanelProps {
  currentProject: { name: string; path: string } | null;
}

function splitGitPath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const fileName = parts.pop() ?? normalized;
  return {
    fileName,
    parentPath: parts.join("\\"),
  };
}

function isAbsolutePath(path: string) {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/");
}

function resolveProjectFilePath(projectPath: string, filePath: string) {
  if (isAbsolutePath(filePath)) {
    return filePath;
  }

  return `${projectPath.replace(/[\\/]+$/, "")}/${filePath.replace(/^[\\/]+/, "")}`;
}

function getGitOperationPaths(file: GitFileStatus): string[] {
  return Array.from(new Set([file.oldPath, file.path].filter((path): path is string => !!path)));
}

function canOperateOnHunks(file: GitFileStatus) {
  return file.statusType !== "conflicted"
    && file.statusType !== "deleted"
    && file.statusType !== "typechange"
    && file.statusType !== "untracked";
}

function SidebarGitPanel({ currentProject }: SidebarGitPanelProps) {
  const { t } = useTranslation();
  const openGitDiffTab = useAppStore((s) => s.openGitDiffTab);
  const openFileTab = useAppStore((s) => s.openFileTab);
  const activeDiffKey = useAppStore((s) => {
    const focusedTabId = s.focusedTabId;
    const diffDocument = focusedTabId ? s.gitDiffDocuments[focusedTabId] : undefined;
    return diffDocument
      ? `${diffDocument.staged ? "staged" : "unstaged"}-${diffDocument.path}`
      : null;
  });
  const gitChangesCollapsed = useAppStore((s) => s.sidebarGitChangesCollapsed);
  const gitGraphCollapsed = useAppStore((s) => s.sidebarGitGraphCollapsed);
  const toggleGitChangesCollapsed = useAppStore((s) => s.toggleGitChangesCollapsed);
  const toggleGitGraphCollapsed = useAppStore((s) => s.toggleGitGraphCollapsed);
  const setGitChangeCount = useAppStore((s) => s.setGitChangeCount);
  const setGitSyncCounts = useAppStore((s) => s.setGitSyncCounts);
  const defaultAgentId = useAppStore((s) => s.defaultAgentId);
  const gitCommitMessageProfiles = useAppStore((s) => s.gitCommitMessageProfiles);
  const defaultGitCommitMessageProfileId = useAppStore(
    (s) => s.defaultGitCommitMessageProfileId,
  );
  const diffOpenRequestRef = useRef(0);
  const [fileHistoryPath, setFileHistoryPath] = useState<string | null>(null);

  useEffect(() => {
    setFileHistoryPath(null);
    const projectPath = currentProject?.path;
    if (!projectPath) return;

    const applyRequest = (detail: GitFileHistoryOpenDetail | undefined) => {
      if (!detail || detail.projectPath !== projectPath) return;
      setFileHistoryPath(detail.filePath);
    };
    const handleRequest = (event: Event) => {
      const detail = (event as CustomEvent<GitFileHistoryOpenDetail>).detail;
      applyRequest(detail);
      if (detail?.projectPath === projectPath) {
        takePendingGitFileHistoryOpen(projectPath);
      }
    };

    window.addEventListener(GIT_FILE_HISTORY_OPEN_EVENT, handleRequest as EventListener);
    applyRequest(takePendingGitFileHistoryOpen(projectPath) ?? undefined);
    return () => {
      window.removeEventListener(GIT_FILE_HISTORY_OPEN_EVENT, handleRequest as EventListener);
    };
  }, [currentProject?.path]);

  // 使用 useGitStatus hook 管理 Git 状态
  const {
    isRepo,
    loading,
    branchInfo,
    fileStatuses,
    stagedFiles,
    unstagedFiles,
    branchName: rawBranchName,
    hasLocalChanges,
    hasSyncChanges,
    syncChangeCount,
    refresh: loadGitData,
  } = useGitStatus({
    currentProject,
    onStatusChange: useCallback(
      (changeCount: number, ahead: number, behind: number) => {
        setGitChangeCount(changeCount);
        setGitSyncCounts(ahead, behind);
      },
      [setGitChangeCount, setGitSyncCounts]
    ),
  });

  // 处理 detached HEAD 状态
  const branchName = rawBranchName || t("sidebar.gitDetached");

  // 使用 useGitCommit hook 管理提交操作
  const {
    committing,
    commit,
    commitAmend,
    commitAndPush,
    commitAndSync,
    pull,
    sync: syncChanges,
  } = useGitCommit({
    projectPath: currentProject?.path ?? null,
    stagedFiles,
    unstagedFiles,
    ahead: branchInfo?.ahead ?? 0,
    behind: branchInfo?.behind ?? 0,
    refresh: loadGitData,
  });

  const [generatingCommitMessage, setGeneratingCommitMessage] = useState(false);
  const [openingDiffPath, setOpeningDiffPath] = useState<string | null>(null);
  const [showGitChangesPanel, setShowGitChangesPanel] = useState(true);
  const [showGitGraphPanel, setShowGitGraphPanel] = useState(true);
  const [showBranchPanel, setShowBranchPanel] = useState(false);
  const [stagedCollapsed, setStagedCollapsed] = useState(false);
  const [changesCollapsed, setChangesCollapsed] = useState(false);
  const [discardConfirmVisible, setDiscardConfirmVisible] = useState(false);
  const [discardConfirmFiles, setDiscardConfirmFiles] = useState<GitFileStatus[]>([]);
  const [discardConfirmTitle, setDiscardConfirmTitle] = useState("");
  const [discardSubmitting, setDiscardSubmitting] = useState(false);
  const [remoteModalOpen, setRemoteModalOpen] = useState(false);
  const [remoteName, setRemoteName] = useState("origin");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteBranch, setRemoteBranch] = useState("");
  const [remoteSubmitting, setRemoteSubmitting] = useState(false);

  const canGenerateCommitMessage =
    !generatingCommitMessage &&
    !!defaultAgentId &&
    !!currentProject &&
    fileStatuses.length > 0;
  const changesMenuItems: MenuProps["items"] = [
    {
      key: "discard-all",
      label: t("sidebar.gitDiscardAll"),
      danger: true,
    },
  ];
  const collapsePanelMenuItems: MenuProps["items"] = [
    {
      key: "toggle-git-changes-panel",
      label: t("sidebar.gitChangesPanel"),
      icon: showGitChangesPanel ? <CheckOutlined /> : <span className="inline-block w-[14px]" />,
    },
    {
      key: "toggle-git-graph-panel",
      label: t("sidebar.gitGraphPanel"),
      icon: showGitGraphPanel ? <CheckOutlined /> : <span className="inline-block w-[14px]" />,
    },
  ];

  const handleViewDiff = useCallback(
    async (
      filePath: string,
      staged: boolean,
      oldFilePath?: string | null,
      hunkActionsAvailable?: boolean,
      preview = true,
    ) => {
      if (!currentProject) return;
      const requestId = ++diffOpenRequestRef.current;
      setOpeningDiffPath(filePath);
      try {
        const diffDocument = await gitDiffContent(currentProject.path, filePath, staged, oldFilePath);
        if (requestId !== diffOpenRequestRef.current) return;
        if (diffDocument.isBinary) return;
        openGitDiffTab({
          path: diffDocument.filePath,
          oldPath: oldFilePath,
          name: splitGitPath(diffDocument.filePath).fileName,
          staged,
          hunkActionsAvailable,
          originalContent: diffDocument.originalContent,
          modifiedContent: diffDocument.modifiedContent,
          originalLabel: diffDocument.originalLabel,
          modifiedLabel: diffDocument.modifiedLabel,
          isBinary: diffDocument.isBinary,
        }, { preview });
      } catch (error) {
        if (requestId !== diffOpenRequestRef.current) return;
        const detail = typeof error === "string" ? error : "";
        message.error(detail ? `打开差异失败: ${detail}` : "打开差异失败");
      } finally {
        if (requestId === diffOpenRequestRef.current) {
          setOpeningDiffPath(null);
        }
      }
    },
    [currentProject, openGitDiffTab]
  );

  const handleDiscard = useCallback(
    (file: GitFileStatus) => {
      setDiscardConfirmFiles([file]);
      setDiscardConfirmTitle(t("sidebar.gitDiscardConfirm", { name: file.path }));
      setDiscardConfirmVisible(true);
    },
    [t]
  );

  const handleOpenFile = useCallback(
    (filePath: string) => {
      if (!currentProject) return;
      openFileTab(resolveProjectFilePath(currentProject.path, filePath), { preview: false });
    },
    [currentProject, openFileTab]
  );

  const handleOpenPathInManager = useCallback(
    async (filePath: string) => {
      if (!currentProject) return;
      try {
        await openInFileManager(resolveProjectFilePath(currentProject.path, filePath));
      } catch {
        message.error(t("common.openInFileManager", { defaultValue: "在文件管理器中打开" }));
      }
    },
    [currentProject, t]
  );

  const handleRevealInExplorer = useCallback(
    (filePath: string) => {
      if (!currentProject) return;
      revealExplorerPath(resolveProjectFilePath(currentProject.path, filePath), "file");
    },
    [currentProject]
  );

  const handleStageFile = useCallback(
    async (file: GitFileStatus) => {
      const controller = getGitRefreshController();
      controller?.markOperationStart();
      try {
        await gitStageFiles(currentProject!.path, getGitOperationPaths(file));
        message.success(t("sidebar.gitStageSuccess"));
        await loadGitData();
      } catch {
        message.error(t("sidebar.gitStageFailed"));
        // 失败时回滚：重新加载真实数据
        await loadGitData();
      } finally {
        controller?.markOperationEnd();
      }
    },
    [currentProject, loadGitData, t]
  );

  const handleUnstageFile = useCallback(
    async (file: GitFileStatus) => {
      const controller = getGitRefreshController();
      controller?.markOperationStart();
      try {
        await gitUnstageFiles(currentProject!.path, getGitOperationPaths(file));
        message.success(t("sidebar.gitUnstageSuccess"));
        await loadGitData();
      } catch {
        message.error(t("sidebar.gitUnstageFailed"));
        // 失败时回滚：重新加载真实数据
        await loadGitData();
      } finally {
        controller?.markOperationEnd();
      }
    },
    [currentProject, loadGitData, t]
  );

  const handleStageAll = useCallback(async () => {
    if (!currentProject || unstagedFiles.length === 0) return;
    const controller = getGitRefreshController();
    controller?.markOperationStart();
    try {
      const files = Array.from(new Set(unstagedFiles.flatMap(getGitOperationPaths)));
      await gitStageFiles(currentProject.path, files);
      message.success(t("sidebar.gitStageSuccess"));
      await loadGitData();
    } catch {
      message.error(t("sidebar.gitStageFailed"));
      // 失败时回滚
      await loadGitData();
    } finally {
      controller?.markOperationEnd();
    }
  }, [currentProject, unstagedFiles, loadGitData, t]);

  const handleDiscardAll = useCallback(() => {
    setDiscardConfirmFiles(unstagedFiles);
    setDiscardConfirmTitle(t("sidebar.gitDiscardAllConfirm"));
    setDiscardConfirmVisible(true);
  }, [unstagedFiles, t]);

  const handleUnstageAll = useCallback(async () => {
    if (!currentProject || stagedFiles.length === 0) return;
    const controller = getGitRefreshController();
    controller?.markOperationStart();
    try {
      const files = Array.from(new Set(stagedFiles.flatMap(getGitOperationPaths)));
      await gitUnstageFiles(currentProject.path, files);
      message.success(t("sidebar.gitUnstageSuccess"));
      await loadGitData();
    } catch {
      message.error(t("sidebar.gitUnstageFailed"));
      // 失败时回滚
      await loadGitData();
    } finally {
      controller?.markOperationEnd();
    }
  }, [currentProject, stagedFiles, loadGitData, t]);

  const handleChangesMenuClick = useCallback(
    ({ key }: { key: string }) => {
      if (key === "discard-all") {
        handleDiscardAll();
      }
    },
    [handleDiscardAll]
  );

  const buildFileMenu = useCallback(
    (file: GitFileStatus, staged: boolean): MenuProps => {
      const canOpenWorkingTree =
        file.statusType !== "deleted" && file.statusType !== "typechange";
      const items: NonNullable<MenuProps["items"]> = [
        {
          key: "open-diff",
          label: t("sidebar.gitContextOpenChanges", { defaultValue: "打开更改" }),
        },
        {
          key: "open-file",
          label: t("sidebar.gitContextOpenFile", { defaultValue: "打开文件" }),
          disabled: !canOpenWorkingTree,
        },
        { type: "divider" },
        staged
          ? {
              key: "unstage",
              label: t("sidebar.gitUnstage"),
            }
          : {
              key: "stage",
              label: t("sidebar.gitStage"),
            },
      ];

      if (!staged) {
        items.push({
          key: "discard",
          label: t("sidebar.gitContextDiscardChanges", { defaultValue: "放弃更改" }),
          danger: true,
        });
      }

      items.push(
        { type: "divider" },
        {
          key: "show-in-manager",
          label: t("sidebar.gitContextShowInManager", { defaultValue: "在文件资源管理器中显示" }),
          disabled: !canOpenWorkingTree,
        },
        {
          key: "reveal-in-explorer",
          label: t("sidebar.gitContextRevealInExplorer", { defaultValue: "在资源管理器视图中显示" }),
        }
      );

      return {
        items,
        onClick: ({ key }) => {
          switch (key) {
            case "open-diff":
              void handleViewDiff(
                file.path,
                staged,
                file.oldPath,
                canOperateOnHunks(file),
              );
              break;
            case "open-file":
              handleOpenFile(file.path);
              break;
            case "stage":
              void handleStageFile(file);
              break;
            case "unstage":
              void handleUnstageFile(file);
              break;
            case "discard":
              handleDiscard(file);
              break;
            case "show-in-manager":
              void handleOpenPathInManager(file.path);
              break;
            case "reveal-in-explorer":
              handleRevealInExplorer(file.path);
              break;
            default:
              break;
          }
        },
      };
    },
    [
      handleDiscard,
      handleOpenFile,
      handleOpenPathInManager,
      handleRevealInExplorer,
      handleStageFile,
      handleUnstageFile,
      handleViewDiff,
      t,
    ]
  );

  const handleCollapsePanelMenuClick = useCallback(
    ({ key }: { key: string }) => {
      switch (key) {
        case "toggle-git-changes-panel":
          setShowGitChangesPanel((value) => !value);
          break;
        case "toggle-git-graph-panel":
          setShowGitGraphPanel((value) => !value);
          break;
        default:
          break;
      }
    },
    []
  );

  const handleGenerateCommitMessage = useCallback(async (profileId?: string) => {
    if (!currentProject || generatingCommitMessage || fileStatuses.length === 0) return null;
    if (!defaultAgentId) {
      message.warning(t("settings.agents.defaultRequired"));
      return null;
    }
    const selectedProfile = gitCommitMessageProfiles.find(
      (profile) => profile.id === (profileId ?? defaultGitCommitMessageProfileId),
    ) ?? gitCommitMessageProfiles[0];
    if (!selectedProfile) {
      message.warning(t("sidebar.gitCommitMessageProfileRequired"));
      return null;
    }

    setGeneratingCommitMessage(true);
    try {
      const generatedMessage = await gitGenerateCommitMessage(
        currentProject.path,
        defaultAgentId,
        selectedProfile.instructions,
      );
      message.success(t("sidebar.gitGenerateCommitMessageSuccessWithProfile", {
        profile: selectedProfile.name,
      }));
      return generatedMessage;
    } catch (error) {
      const detail = `${t("sidebar.gitGenerateCommitMessageFailed")}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      message.error(detail);
      throw new Error(detail);
    } finally {
      setGeneratingCommitMessage(false);
    }
  }, [
    currentProject,
    defaultAgentId,
    defaultGitCommitMessageProfileId,
    fileStatuses.length,
    generatingCommitMessage,
    gitCommitMessageProfiles,
    t,
  ]);

  const handleDiscardConfirm = useCallback(async () => {
    if (!currentProject || discardConfirmFiles.length === 0) return;
    const controller = getGitRefreshController();
    controller?.markOperationStart();
    setDiscardSubmitting(true);
    try {
      const files = Array.from(new Set(discardConfirmFiles.flatMap(getGitOperationPaths)));
      await gitDiscardChanges(currentProject.path, files);
      message.success(t("sidebar.gitDiscardSuccess"));
      setDiscardConfirmVisible(false);
      setDiscardConfirmFiles([]);
      await loadGitData();
    } catch {
      message.error(t("sidebar.gitDiscardFailed"));
      // 失败时回滚
      await loadGitData();
    } finally {
      setDiscardSubmitting(false);
      controller?.markOperationEnd();
    }
  }, [currentProject, discardConfirmFiles, loadGitData, t]);

  const handleOpenRemoteModal = useCallback(() => {
    if (!currentProject || !rawBranchName || branchInfo?.isDetached) {
      message.warning(t("sidebar.gitConnectRemoteDetached"));
      return;
    }

    setRemoteName("origin");
    setRemoteUrl("");
    setRemoteBranch(rawBranchName);
    setRemoteModalOpen(true);
  }, [branchInfo?.isDetached, currentProject, rawBranchName, t]);

  const handleConnectRemote = useCallback(async () => {
    if (!currentProject || remoteSubmitting) return;

    const trimmedRemoteName = remoteName.trim();
    const trimmedRemoteUrl = remoteUrl.trim();
    const trimmedBranch = remoteBranch.trim();
    if (!trimmedRemoteName || !trimmedRemoteUrl || !trimmedBranch) {
      message.warning(t("sidebar.gitConnectRemoteRequired"));
      return;
    }

    const controller = getGitRefreshController();
    controller?.markOperationStart();
    setRemoteSubmitting(true);
    try {
      const result = await gitAddRemoteAndPush({
        projectPath: currentProject.path,
        remoteName: trimmedRemoteName,
        remoteUrl: trimmedRemoteUrl,
        branchName: trimmedBranch,
      });
      await loadGitData();

      if (!result.success) {
        message.error(`${t("sidebar.gitConnectRemoteFailed")}: ${result.message}`);
        return;
      }

      message.success(t("sidebar.gitConnectRemoteSuccess"));
      setRemoteModalOpen(false);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      message.error(`${t("sidebar.gitConnectRemoteFailed")}: ${detail}`);
    } finally {
      setRemoteSubmitting(false);
      controller?.markOperationEnd();
    }
  }, [currentProject, loadGitData, remoteBranch, remoteName, remoteSubmitting, remoteUrl, t]);

  // No project
  if (!currentProject) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 px-4" style={{ color: "var(--cs-text-tertiary)" }}>
        <BranchesOutlined className="text-3xl" />
        <span className="text-sm text-center">{t("sidebar.noProject")}</span>
      </div>
    );
  }

  // Not a git repo
  if (!isRepo && !loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 px-4" style={{ color: "var(--cs-text-tertiary)" }}>
        <BranchesOutlined className="text-3xl" />
        <span className="text-sm text-center">{t("sidebar.gitNoRepo")}</span>
      </div>
    );
  }

  return (
    <div className="app-sidebar-panel flex h-full min-h-0 flex-col">
      {/* Header */}
      <div
        className="flex items-center justify-between px-2"
        style={{ height: 32, borderBottom: "1px solid var(--cs-border-sidebar)" }}
      >
        <Tooltip title={t("sidebar.gitBranchList")} mouseEnterDelay={0.4}>
          <button
            type="button"
            className="flex items-center gap-1.5 text-sm font-semibold cursor-pointer"
            style={{ color: "var(--cs-text-primary)" }}
            onClick={() => setShowBranchPanel(!showBranchPanel)}
          >
            <BranchesOutlined style={{ fontSize: 14 }} />
            <span className="max-w-[120px] truncate">{branchName}</span>
            {((branchInfo?.ahead ?? 0) > 0 || (branchInfo?.behind ?? 0) > 0) && (
              <span className="text-[10px] px-1 rounded" style={{ background: "color-mix(in srgb, var(--cs-primary) 12%, transparent)", color: "var(--cs-primary)" }}>
                {branchInfo?.ahead ? `↑${branchInfo.ahead}` : ""}
                {branchInfo?.behind ? `↓${branchInfo.behind}` : ""}
              </span>
            )}
          </button>
        </Tooltip>
        <div className="flex items-center gap-1">
          <Tooltip title={t("sidebar.gitConnectRemote")} mouseEnterDelay={0.4}>
            <Button
              type="text"
              size="small"
              icon={<LinkOutlined />}
              onClick={handleOpenRemoteModal}
              disabled={loading || !rawBranchName || branchInfo?.isDetached}
              style={{ color: "var(--cs-text-secondary)" }}
            >
              {t("sidebar.gitConnectRemote")}
            </Button>
          </Tooltip>
          <Dropdown
            trigger={["click"]}
            menu={{ items: collapsePanelMenuItems, onClick: handleCollapsePanelMenuClick }}
          >
            <button
              type="button"
              className="app-file-toolbar-button"
              aria-label={t("sidebar.gitPanelTitle")}
            >
              <EllipsisOutlined />
            </button>
          </Dropdown>
        </div>
      </div>

      {/* Branch panel (collapsible) */}
      {showBranchPanel && (
        <GitBranchPanel
          projectPath={currentProject?.path ?? null}
          currentBranch={branchName}
          visible={showBranchPanel}
          onClose={() => setShowBranchPanel(false)}
          onBranchChanged={loadGitData}
        />
      )}

      {/* Scrollable content */}
      <div className="flex flex-1 min-h-0 flex-col overflow-y-auto app-project-tree-scroll px-1 py-1">
        {/* Conflict panel */}
        {!fileHistoryPath && (() => {
          const conflictFiles = unstagedFiles.filter(
            (f) => f.statusType === "conflicted"
          );
          if (conflictFiles.length > 0) {
            return (
              <div className="mb-2">
                <GitConflictPanel
                  projectPath={currentProject!.path}
                  conflictFiles={conflictFiles}
                  onConflictResolved={loadGitData}
                />
              </div>
            );
          }
          return null;
        })()}

        {/* Changes section */}
        {showGitChangesPanel && !fileHistoryPath && (
          <div>
            <div className="flex items-center justify-between px-2 py-1.5">
              <button
                className="flex items-center gap-1.5 text-left text-[13px] font-semibold"
                style={{ color: "var(--cs-text-primary)" }}
                onClick={toggleGitChangesCollapsed}
              >
                <DownOutlined className={`text-[9px] transition-transform ${gitChangesCollapsed ? "-rotate-90" : ""}`} />
                <span>{t("sidebar.gitChangesPanel")}</span>
              </button>
              <div className="flex items-center gap-1">
                <Tooltip title={t("sidebar.gitRefresh")} mouseEnterDelay={0.4}>
                  <Button
                    type="text"
                    size="small"
                    icon={loading ? <LoadingOutlined /> : <ReloadOutlined />}
                    style={{
                      width: 24,
                      height: 24,
                      padding: 0,
                      color: "var(--cs-text-secondary)",
                    }}
                    onClick={loadGitData}
                    disabled={loading}
                  />
                </Tooltip>
              </div>
            </div>

            {!gitChangesCollapsed && (
              <div>
                {/* Commit composer */}
                <GitCommitComposer
                  branchName={branchName}
                  hasLocalChanges={hasLocalChanges}
                  stagedChangeCount={stagedFiles.length}
                  unstagedChangeCount={unstagedFiles.length}
                  aheadCount={branchInfo?.ahead ?? 0}
                  behindCount={branchInfo?.behind ?? 0}
                  hasSyncChanges={hasSyncChanges}
                  syncChangeCount={syncChangeCount}
                  committing={committing}
                  canGenerateCommitMessage={canGenerateCommitMessage}
                  generateCommitMessageHint={
                    defaultAgentId
                      ? t("sidebar.gitGenerateCommitMessage")
                      : t("settings.agents.defaultRequired")
                  }
                  generatingCommitMessage={generatingCommitMessage}
                  commitMessageProfiles={gitCommitMessageProfiles}
                  defaultCommitMessageProfileId={defaultGitCommitMessageProfileId}
                  onCommit={commit}
                  onCommitAmend={commitAmend}
                  onCommitAndPush={commitAndPush}
                  onCommitAndSync={commitAndSync}
                  onPull={pull}
                  onSyncChanges={syncChanges}
                  onGenerateCommitMessage={handleGenerateCommitMessage}
                />

                {/* Staged files */}
                <GitFileList
                  files={stagedFiles}
                  staged={true}
                  sectionTitle={t("sidebar.gitStagedSection")}
                  actionText={t("sidebar.gitUnstage")}
                  collapsed={stagedCollapsed}
                  onToggleCollapse={() => setStagedCollapsed(!stagedCollapsed)}
                  openingDiffPath={openingDiffPath}
                  activeDiffKey={activeDiffKey}
                  onViewDiff={handleViewDiff}
                  onToggleFile={handleUnstageFile}
                  onToggleAll={handleUnstageAll}
                  buildFileMenu={buildFileMenu}
                />

                {/* Unstaged files */}
                <GitFileList
                  files={unstagedFiles}
                  staged={false}
                  sectionTitle={t("sidebar.gitChangesSection")}
                  actionText={t("sidebar.gitStage")}
                  collapsed={changesCollapsed}
                  onToggleCollapse={() => setChangesCollapsed(!changesCollapsed)}
                  openingDiffPath={openingDiffPath}
                  activeDiffKey={activeDiffKey}
                  onViewDiff={handleViewDiff}
                  onToggleFile={handleStageFile}
                  onToggleAll={handleStageAll}
                  buildFileMenu={buildFileMenu}
                  extraActions={
                    <Dropdown
                      trigger={["click"]}
                      menu={{ items: changesMenuItems, onClick: handleChangesMenuClick }}
                    >
                      <Button
                        type="text"
                        size="small"
                        icon={<EllipsisOutlined />}
                        style={{ width: 20, height: 20, padding: 0, color: "var(--cs-text-secondary)" }}
                      />
                    </Dropdown>
                  }
                />

                {/* No changes */}
                {fileStatuses.length === 0 && !loading && (
                  <div className="flex flex-col items-center justify-center gap-2 py-8" style={{ color: "var(--cs-text-tertiary)" }}>
                    <CheckOutlined className="text-2xl" />
                    <span className="text-sm">{t("sidebar.gitNoChanges")}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Graph section */}
        {showGitGraphPanel && (
          <div className={fileHistoryPath
            ? "flex min-h-0 flex-1 flex-col"
            : showGitChangesPanel && !gitChangesCollapsed
              ? "mt-auto shrink-0"
              : "shrink-0"}
          >
            <GitGraphSection
              projectPath={currentProject?.path ?? null}
              collapsed={fileHistoryPath ? false : gitGraphCollapsed}
              onToggleCollapse={toggleGitGraphCollapsed}
              sectionTitle={t("sidebar.gitGraphPanel")}
              refreshText={t("sidebar.gitRefresh")}
              placeholderText={t("sidebar.gitGraphPlaceholder")}
              fileHistoryPath={fileHistoryPath}
              onClearFileHistory={() => setFileHistoryPath(null)}
            />
          </div>
        )}
      </div>

      {/* Discard confirmation modal */}
      <Modal
        title={discardConfirmTitle}
        open={discardConfirmVisible}
        okText={t("sidebar.gitDiscardConfirmOk")}
        cancelText={t("common.cancel")}
        okButtonProps={{ danger: true }}
        confirmLoading={discardSubmitting}
        onOk={handleDiscardConfirm}
        onCancel={() => {
          if (discardSubmitting) return;
          setDiscardConfirmVisible(false);
          setDiscardConfirmFiles([]);
        }}
      >
        <p>
          {discardConfirmFiles.some((file) => file.statusType === "untracked")
            ? t("sidebar.gitDiscardIncludesUntracked")
            : discardConfirmFiles.length > 1
              ? t("sidebar.gitDiscardAllConfirm")
              : t("sidebar.gitDiscardConfirm", { name: discardConfirmFiles[0]?.path || "" })}
        </p>
      </Modal>

      <Modal
        title={t("sidebar.gitConnectRemoteTitle")}
        open={remoteModalOpen}
        okText={t("sidebar.gitConnectRemoteAction")}
        cancelText={t("common.cancel")}
        confirmLoading={remoteSubmitting}
        onOk={() => void handleConnectRemote()}
        onCancel={() => {
          if (!remoteSubmitting) setRemoteModalOpen(false);
        }}
        destroyOnHidden
      >
        <div className="space-y-4">
          <p className="m-0 text-sm" style={{ color: "var(--cs-text-secondary)" }}>
            {t("sidebar.gitConnectRemoteDescription")}
          </p>
          <label className="block space-y-1.5">
            <span className="text-sm" style={{ color: "var(--cs-text-primary)" }}>
              {t("sidebar.gitRemoteName")}
            </span>
            <Input
              value={remoteName}
              onChange={(event) => setRemoteName(event.target.value)}
              placeholder="origin"
              disabled={remoteSubmitting}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm" style={{ color: "var(--cs-text-primary)" }}>
              {t("sidebar.gitRemoteUrl")}
            </span>
            <Input
              autoFocus
              value={remoteUrl}
              onChange={(event) => setRemoteUrl(event.target.value)}
              placeholder="https://github.com/owner/repository.git"
              disabled={remoteSubmitting}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm" style={{ color: "var(--cs-text-primary)" }}>
              {t("sidebar.gitRemoteBranch")}
            </span>
            <Input
              value={remoteBranch}
              onChange={(event) => setRemoteBranch(event.target.value)}
              disabled={remoteSubmitting}
            />
          </label>
        </div>
      </Modal>

    </div>
  );
}

export default SidebarGitPanel;
