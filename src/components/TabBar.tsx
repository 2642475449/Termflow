import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, Tooltip, Dropdown, message } from "antd";
import type { MenuProps } from "antd";
import {
  CloseOutlined,
  ExportOutlined,
  LoadingOutlined,
  SettingOutlined,
  PlusOutlined,
  FolderOpenFilled,
  CopyOutlined,
  StopOutlined,
  CloseCircleOutlined,
} from "@ant-design/icons";
import { useAppStore, type SplitDirection, type TabDropPosition } from "@/store";
import { openInAssociatedApplication, openInFileManager } from "@/lib/api";
import { inspectAgentClis } from "@/lib/api";
import { getFileIconByName } from "@/lib/fileIcon";
import { useTranslation } from "react-i18next";
import { ShortcutHint } from "@/components/ui/ShortcutHint";
import { getKeysForAction } from "@/constants/shortcuts";
import { closeTabRuntime, confirmCloseTab } from "@/lib/tabClose";
import { AgentIcon } from "@/components/AgentIcon";
import { AgentActivityIcon } from "@/components/AgentActivityIcon";
import {
  getAgentIdsWithCapability,
  getAgentDisplayName,
  getDefaultAgentLaunchOptions,
  isAiAgentId,
} from "@/lib/agents";
import type {
  AgentCliInfo,
  NewSessionLaunchRequest,
} from "@/types";

const SETTINGS_ID = "__settings__";
const LONG_PRESS_MS = 180;
const MOVE_CANCEL_THRESHOLD = 6;
const INTERACTIVE_AGENT_IDS = getAgentIdsWithCapability("interactiveTerminal");

interface TabMenuIconProps {
  size?: number;
  className?: string;
}

interface TabMenuSvgProps extends TabMenuIconProps {
  children: ReactNode;
}

function TabMenuSvg({ size = 16, className, children }: TabMenuSvgProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      fill="none"
      style={{ display: "block" }}
    >
      {children}
    </svg>
  );
}

function SplitRightIcon({ size, className }: TabMenuIconProps) {
  return (
    <TabMenuSvg size={size} className={className}>
      <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8.5 3.6V12.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </TabMenuSvg>
  );
}

function SplitRightMoveIcon({ size, className }: TabMenuIconProps) {
  return (
    <TabMenuSvg size={size} className={className}>
      <path d="M3.25 8H12.25" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M8.7 4.45L12.25 8L8.7 11.55" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </TabMenuSvg>
  );
}

function SplitDownIcon({ size, className }: TabMenuIconProps) {
  return (
    <TabMenuSvg size={size} className={className}>
      <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.6 8.5H12.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </TabMenuSvg>
  );
}

function SplitDownMoveIcon({ size, className }: TabMenuIconProps) {
  return (
    <TabMenuSvg size={size} className={className}>
      <path d="M8 3.25V12.25" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M4.45 8.7L8 12.25L11.55 8.7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </TabMenuSvg>
  );
}

interface DropTarget {
  tabId: string | null;
  position: TabDropPosition;
}

interface DragPreviewState {
  tabId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

interface PressState {
  tabId: string;
  startX: number;
  startY: number;
  timer: number | null;
}

interface TabBarProps {
  paneId: string;
  tabIds: string[];
  activeTabId: string | null;
}

function TabBar({ paneId, tabIds, activeTabId }: TabBarProps) {
  const { t } = useTranslation();
  const openTabs = tabIds;
  const activeSessionId = activeTabId;
  const sessions = useAppStore((s) => s.sessions);
  const tabsById = useAppStore((s) => s.tabsById);
  const panesById = useAppStore((s) => s.panesById);
  const dragState = useAppStore((s) => s.dragState);
  const currentProject = useAppStore((s) => s.currentProject);
  const agentPermissionDefaults = useAppStore((s) => s.agentPermissionDefaults);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const closeTab = useAppStore((s) => s.closeTab);
  const splitTab = useAppStore((s) => s.splitTab);
  const setDragState = useAppStore((s) => s.setDragState);
  const promoteTab = useAppStore((s) => s.promoteTab);

  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);
  const [availableAgents, setAvailableAgents] = useState<AgentCliInfo[] | null>(null);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const pressStateRef = useRef<PressState | null>(null);
  const suppressClickRef = useRef(false);

  const draggingTabId = dragState?.phase === "dragging" ? dragState.sourceTabId : null;
  const dropTarget: DropTarget | null =
    dragState?.phase === "dragging" &&
    dragState.targetPaneId === paneId &&
    (dragState.position === "before" || dragState.position === "after")
      ? { tabId: dragState.targetTabId, position: dragState.position }
      : null;
  const isCrossPaneDropTarget =
    dragState?.phase === "dragging" &&
    dragState.targetPaneId === paneId &&
    dragState.sourcePaneId !== paneId;
  const ownsActiveDrag = dragState?.sourcePaneId === paneId;
  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions]
  );

  const loadAvailableAgents = useCallback(async (
    options?: { forceRefresh?: boolean; showLoading?: boolean },
  ) => {
    const forceRefresh = options?.forceRefresh === true;
    const showLoading = options?.showLoading === true;
    if (showLoading) {
      setLoadingAgents(true);
    }
    try {
      const agents = await inspectAgentClis(forceRefresh ? { forceRefresh: true } : undefined);
      setAvailableAgents(agents);
    } catch (error) {
      console.error("Failed to load agents for the new-session menu:", error);
      setAvailableAgents([]);
    } finally {
      if (showLoading) {
        setLoadingAgents(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!currentProject || availableAgents) return;
    let disposed = false;
    void (async () => {
      try {
        setLoadingAgents(true);
        const agents = await inspectAgentClis();
        if (!disposed) {
          setAvailableAgents(agents);
        }
      } catch (error) {
        console.error("Failed to load agents for the new-session menu:", error);
        if (!disposed) {
          setAvailableAgents([]);
        }
      } finally {
        if (!disposed) {
          setLoadingAgents(false);
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [availableAgents, currentProject]);

  function cleanupPressState() {
    if (pressStateRef.current?.timer) {
      window.clearTimeout(pressStateRef.current.timer);
    }
    pressStateRef.current = null;
  }

  function finishDragging() {
    cleanupPressState();
    setDragPreview(null);
    setDragState(null);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      if (!draggingTabId) {
        const pressState = pressStateRef.current;
        if (!pressState) return;
        const movedX = event.clientX - pressState.startX;
        const movedY = event.clientY - pressState.startY;
        if (Math.hypot(movedX, movedY) > MOVE_CANCEL_THRESHOLD) {
          cleanupPressState();
        }
        return;
      }
      if (!ownsActiveDrag) return;

      const elementAtPointer = document.elementFromPoint(event.clientX, event.clientY);
      const targetBar = elementAtPointer?.closest<HTMLElement>("[data-tabbar-pane]");
      const targetPaneId = targetBar?.dataset.tabbarPane ?? null;
      let nextTarget: DropTarget | null = null;
      if (targetBar) {
        for (const node of targetBar.querySelectorAll<HTMLElement>("[data-tab-id]")) {
          const tabId = node.dataset.tabId;
          if (!tabId) continue;
          const rect = node.getBoundingClientRect();
          if (
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom
          ) {
            nextTarget = {
              tabId,
              position: event.clientX <= rect.left + rect.width / 2 ? "before" : "after",
            };
            break;
          }
        }
      }

      const latestDragState = useAppStore.getState().dragState;
      if (latestDragState?.phase === "dragging") {
        const isOwnTab =
          targetPaneId === latestDragState.sourcePaneId &&
          nextTarget?.tabId === latestDragState.sourceTabId;
        setDragState({
          ...latestDragState,
          type:
            targetPaneId && targetPaneId !== latestDragState.sourcePaneId
              ? "tab-move"
              : "tab-reorder",
          targetPaneId,
          targetTabId: isOwnTab ? null : nextTarget?.tabId ?? null,
          position: isOwnTab
            ? null
            : nextTarget?.position ?? (targetPaneId ? "into-empty-pane" : null),
        });
      }

      setDragPreview((current) =>
        current
          ? {
              ...current,
              x: event.clientX - current.offsetX,
              y: event.clientY - current.offsetY,
            }
          : current
      );
    }

    function handlePointerUp() {
      if (!draggingTabId) {
        cleanupPressState();
        return;
      }
      if (!ownsActiveDrag) return;
      const latest = useAppStore.getState();
      const latestDragState = latest.dragState;
      if (latestDragState?.phase === "dragging" && latestDragState.targetPaneId) {
        if (latestDragState.sourcePaneId !== latestDragState.targetPaneId) {
          latest.moveTab(
            latestDragState.sourceTabId,
            latestDragState.sourcePaneId,
            latestDragState.targetPaneId,
            latestDragState.targetTabId,
            latestDragState.position === "before" || latestDragState.position === "after"
              ? latestDragState.position
              : undefined
          );
        } else if (
          latestDragState.targetTabId &&
          (latestDragState.position === "before" || latestDragState.position === "after")
        ) {
          latest.reorderTabs(
            latestDragState.sourceTabId,
            latestDragState.targetTabId,
            latestDragState.position,
            latestDragState.sourcePaneId
          );
        }
      }
      finishDragging();
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [draggingTabId, ownsActiveDrag, setDragState]);

  function getTabMenuItems(tabId: string): MenuProps["items"] {
    const isSettings = tabId === SETTINGS_ID;
    const tab = tabsById[tabId];
    const isFile = tab?.kind === "file";
    const isDiff = tab?.kind === "diff";
    const session = isSettings || isFile || isDiff ? null : sessionById.get(tabId);

    const closeKeys = getKeysForAction("closeTab");

    const items: MenuProps["items"] = [
      {
        key: "close",
        label: (
          <span className="flex items-center justify-between w-full">
            <span>{t("tabBar.closeTab")}</span>
            {closeKeys && <ShortcutHint keys={closeKeys} />}
          </span>
        ),
        icon: <CloseOutlined />,
      },
      {
        key: "close-others",
        label: t("tabBar.closeOtherTabs"),
        icon: <StopOutlined />,
        disabled: openTabs.length <= 1,
      },
      {
        key: "close-all",
        label: t("tabBar.closeAllTabs"),
        icon: <CloseCircleOutlined />,
      },
      { type: "divider" },
      {
        key: "split-right-copy",
        label: t("tabBar.splitRight"),
        icon: <SplitRightIcon />,
      },
      {
        key: "split-right-move",
        label: t("tabBar.splitMoveRight"),
        icon: <SplitRightMoveIcon />,
        disabled: openTabs.length <= 1,
      },
      {
        key: "split-down-copy",
        label: t("tabBar.splitDown"),
        icon: <SplitDownIcon />,
      },
      {
        key: "split-down-move",
        label: t("tabBar.splitMoveDown"),
        icon: <SplitDownMoveIcon />,
        disabled: openTabs.length <= 1,
      },
    ];

    if (session || isFile || isDiff) {
      items.push({ type: "divider" });
      items.push({
        key: "open-folder",
        label: t("common.openInFileManager"),
        icon: <FolderOpenFilled />,
      });
      items.push({
        key: "copy-path",
        label: t("common.copyPath"),
        icon: <CopyOutlined />,
      });
      if (isFile || isDiff) {
        items.push({
          key: "open-associated-app",
          label: t("common.openInAssociatedApp"),
          icon: <ExportOutlined />,
        });
      }
    }

    return items;
  }

  function handleTabMenuClick(key: string, tabId: string) {
    const isSettings = tabId === SETTINGS_ID;
    const tab = tabsById[tabId];
    const isFile = tab?.kind === "file";
    const isDiff = tab?.kind === "diff";
    const session = isSettings || isFile || isDiff ? null : sessionById.get(tabId);
    const targetPath = isFile || isDiff ? tab?.resourceId : session?.path;

    if (key.startsWith("split-")) {
      const [, direction, mode] = key.split("-");
      splitTab(tabId, direction as SplitDirection, paneId, mode as "copy" | "move");
      return;
    }

    switch (key) {
      case "close":
        void requestCloseTabs([tabId]);
        return;
      case "close-others":
        void requestCloseTabs(openTabs.filter((id) => id !== tabId));
        return;
      case "close-all":
        void requestCloseTabs([...openTabs]);
        return;
      case "open-folder":
        if (targetPath) {
          openInFileManager(targetPath).catch(() => message.error(t("sidebar.openFolderFailed")));
        }
        break;
      case "copy-path":
        if (targetPath) {
          navigator.clipboard.writeText(targetPath).then(() => message.success(t("sidebar.copyPathSuccess")));
        }
        break;
      case "open-associated-app":
        if (targetPath) {
          openInAssociatedApplication(targetPath).catch(() =>
            message.error(t("sidebar.openAssociatedAppFailed"))
          );
        }
        break;
    }
  }

  async function requestCloseTabs(tabIds: string[]) {
    for (const id of tabIds) {
      const nextTab = tabsById[id];
      const canClose = await confirmCloseTab(nextTab, t);
      if (!canClose) {
        break;
      }
      const openInAnotherPane = Object.entries(panesById).some(
        ([otherPaneId, pane]) => otherPaneId !== paneId && pane.tabIds.includes(id),
      );
      if (!openInAnotherPane) await closeTabRuntime(nextTab);
      closeTab(id, paneId);
    }
  }

  function handleCreateSession(request: NewSessionLaunchRequest) {
    if (!currentProject) return;
    setActiveSession(activeSessionId, paneId);
    window.dispatchEvent(
      new CustomEvent<NewSessionLaunchRequest>("session:create-request", { detail: request }),
    );
  }

  const newSessionMenuItems: MenuProps["items"] = [
    {
      key: "terminals",
      type: "group",
      label: t("newSessionMenu.terminals"),
      children: [
        {
          key: "terminal:powershell",
          icon: <AgentIcon agentId="powershell" size={16} />,
          label: t("newSessionMenu.powershell"),
        },
        {
          key: "terminal:cmd",
          icon: <AgentIcon agentId="cmd" size={16} />,
          label: t("newSessionMenu.cmd"),
        },
      ],
    },
    { type: "divider" },
    {
      key: "agents",
      type: "group",
      label: t("newSessionMenu.agents"),
      children: availableAgents === null || loadingAgents
        ? [{ key: "agents:loading", disabled: true, icon: <LoadingOutlined spin />, label: t("newSessionMenu.detecting") }]
        : INTERACTIVE_AGENT_IDS
            .filter((agentId) =>
              availableAgents.some((item) => item.id === agentId && item.installed),
            )
            .map((agentId) => {
              const agent = availableAgents.find((item) => item.id === agentId);
              return {
                key: `agent:${agentId}`,
                icon: <AgentIcon agentId={agentId} size={16} />,
                label: agent?.name ?? getAgentDisplayName(agentId),
              };
            }),
    },
  ];

  function handleNewSessionMenuClick(key: string) {
    if (key === "terminal:powershell" || key === "terminal:cmd") {
      handleCreateSession({ kind: "terminal", shell: key.endsWith("cmd") ? "cmd" : "powershell" });
      return;
    }
    if (!key.startsWith("agent:")) return;
    const agentId = key.slice("agent:".length);
    if (!isAiAgentId(agentId)) return;
    const agent = availableAgents?.find((item) => item.id === agentId && item.installed);
    if (agent) {
      const launchOptions = getDefaultAgentLaunchOptions(agent.id, agentPermissionDefaults);
      handleCreateSession({ kind: "agent", agent, launchOptions });
    }
  }

  return (
    <div
      data-tabbar-pane={paneId}
      className="app-shell-chrome app-glass-tabbar flex items-end overflow-x-auto shrink-0"
      style={{
        background: isCrossPaneDropTarget
          ? "color-mix(in srgb, var(--cs-primary) 10%, transparent)"
          : "transparent",
        minHeight: 36,
        boxShadow: isCrossPaneDropTarget
          ? "inset 0 -2px 0 var(--cs-primary)"
          : undefined,
      }}
    >
      {openTabs.map((tabId) => {
        const isActive = tabId === activeSessionId;
        const isSettings = tabId === SETTINGS_ID;
        const tab = tabsById[tabId];
        const isFile = tab?.kind === "file";
        const isDiff = tab?.kind === "diff";
        const filePath = isFile ? tab?.resourceId ?? null : null;
        const diffPath = isDiff ? tab?.resourceId ?? null : null;
        const session = isSettings || isFile || isDiff ? null : sessionById.get(tabId);
        const isDragging = draggingTabId === tabId;
        const fileVisual = (isFile || isDiff) && tab?.title ? getFileIconByName(tab.title) : null;
        if (!isSettings && !isFile && !isDiff && !session) return null;

        return (
          <Dropdown
            key={tabId}
            menu={{
              items: getTabMenuItems(tabId),
              onClick: ({ key }) => handleTabMenuClick(key, tabId),
            }}
            trigger={["contextMenu"]}
          >
            <div
              data-tab-id={tabId}
              ref={(node) => {
                tabRefs.current[tabId] = node;
              }}
              className="relative shrink-0"
            >
              {dropTarget?.tabId === tabId && (
                <div
                  className="absolute top-1 bottom-1 z-20 w-0.5 rounded-full"
                  style={{
                    background: "var(--cs-primary)",
                    left: dropTarget.position === "before" ? 0 : undefined,
                    right: dropTarget.position === "after" ? 0 : undefined,
                  }}
                />
              )}
              <div
                data-active={isActive ? "true" : "false"}
                className={`tab-item app-tab-chrome app-marker-host app-marker-bottom app-glass-tab ${isActive ? "app-glass-tab-active" : ""} flex items-center gap-1.5 px-3 cursor-pointer shrink-0`}
                style={{
                  opacity: isDragging ? 0.2 : 1,
                  transform: isDragging ? "scale(0.98)" : "none",
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  cleanupPressState();
                  suppressClickRef.current = false;
                  const timer = window.setTimeout(() => {
                    const node = tabRefs.current[tabId];
                    const rect = node?.getBoundingClientRect();
                    suppressClickRef.current = true;
                    document.body.style.userSelect = "none";
                    document.body.style.cursor = "grabbing";
                    if (rect) {
                      setDragPreview({
                        tabId,
                        x: rect.left,
                        y: rect.top,
                        width: rect.width,
                        height: rect.height,
                        offsetX: event.clientX - rect.left,
                        offsetY: event.clientY - rect.top,
                      });
                    }
                    setDragState({
                      type: "tab-reorder",
                      sourceTabId: tabId,
                      sourcePaneId: paneId,
                      targetPaneId: paneId,
                      targetTabId: null,
                      position: null,
                      phase: "dragging",
                      startedAt: Date.now(),
                    });
                  }, LONG_PRESS_MS);
                  pressStateRef.current = {
                    tabId,
                    startX: event.clientX,
                    startY: event.clientY,
                    timer,
                  };
                }}
                onClick={(event) => {
                  if (suppressClickRef.current) {
                    event.preventDefault();
                    event.stopPropagation();
                    suppressClickRef.current = false;
                    return;
                  }
                  setActiveSession(tabId, paneId);
                }}
                onDoubleClick={() => promoteTab(tabId)}
              >
                {isSettings ? (
                  <SettingOutlined className="text-xs" />
                ) : isFile || isDiff ? (
                  <span className="text-xs inline-flex" style={{ color: fileVisual?.color }}>{fileVisual?.icon}</span>
                ) : (
                  <AgentActivityIcon
                    agentId={session?.agentId ?? "claude"}
                    status={session?.status}
                    size={15}
                  />
                )}
                {isSettings ? (
                  <span className="text-xs">{t("common.settings")}</span>
                ) : isFile || isDiff ? (
                  <Tooltip title={filePath ?? diffPath ?? undefined} mouseEnterDelay={0.5}>
                    <span className={`text-xs max-w-[120px] truncate ${tab?.preview ? 'italic opacity-70' : ''}`}>
                      {tab?.title}
                      {tab.dirty ? " *" : ""}
                    </span>
                  </Tooltip>
                ) : (
                  <div className={`flex min-w-0 max-w-[140px] items-center gap-1 ${tab?.preview ? 'italic opacity-70' : ''}`}>
                    <Tooltip title={session!.path} mouseEnterDelay={0.5}>
                      <span className="truncate text-xs">
                        {(tab?.title ?? session!.name) + (tab?.dirty ? " *" : "")}
                      </span>
                    </Tooltip>
                  </div>
                )}
                <Button
                  type="text"
                  size="small"
                  icon={<CloseOutlined style={{ fontSize: 10 }} />}
                  className="tab-close-btn ml-auto shrink-0 !p-0 !w-4 !h-4 !min-w-0 flex items-center justify-center"
                  style={{ color: "var(--cs-text-tertiary)" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    void requestCloseTabs([tabId]);
                  }}
                />
              </div>
            </div>
          </Dropdown>
        );
      })}
      {currentProject && (
        <div
          className="shrink-0 flex items-center justify-center px-1.5 gap-1.5"
          style={{ minHeight: 36 }}
        >
          <Dropdown
            trigger={["click"]}
            placement="bottomLeft"
            onOpenChange={(open) => {
              if (open) {
                void loadAvailableAgents({ showLoading: availableAgents === null });
              }
            }}
            menu={{
              items: newSessionMenuItems,
              onClick: ({ key }) => handleNewSessionMenuClick(key),
              style: { minWidth: 244, padding: 6 },
            }}
          >
          <Tooltip title={t("newSessionMenu.tooltip")} mouseEnterDelay={0.4}>
            <button
              type="button"
              aria-label={t("sidebar.newSession")}
              className="app-tabbar-new-button"
            >
              <PlusOutlined style={{ fontSize: 12, fontWeight: 600 }} />
            </button>
          </Tooltip>
          </Dropdown>
        </div>
      )}
      {dragPreview && typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed z-[9999] flex items-center gap-1.5 px-3 pointer-events-none"
            style={{
              left: dragPreview.x,
              top: dragPreview.y,
              width: dragPreview.width,
              height: dragPreview.height,
              background: "color-mix(in srgb, var(--cs-bg-card-solid, var(--cs-bg-card)) 98%, white 2%)",
              borderTop: "1px solid color-mix(in srgb, var(--cs-border-card, var(--cs-border-sidebar)) 92%, transparent)",
              borderLeft: "1px solid color-mix(in srgb, var(--cs-border-card, var(--cs-border-sidebar)) 92%, transparent)",
              borderRight: "1px solid color-mix(in srgb, var(--cs-border-card, var(--cs-border-sidebar)) 92%, transparent)",
              borderBottom: "2px solid var(--cs-primary)",
              color: "var(--cs-text-primary)",
              borderRadius: "8px",
              boxShadow: "0 10px 28px rgba(0,0,0,0.22)",
              transform: "rotate(1deg)",
              backdropFilter: "blur(14px) saturate(155%)",
              WebkitBackdropFilter: "blur(14px) saturate(155%)",
            }}
          >
            {(() => {
              const previewTab = tabsById[dragPreview.tabId];
              const isPreviewFile = previewTab?.kind === "file" || previewTab?.kind === "diff";
              const previewFileVisual = isPreviewFile && previewTab?.title ? getFileIconByName(previewTab.title) : null;
              if (dragPreview.tabId === SETTINGS_ID) {
                return <SettingOutlined className="text-xs" />;
              }
              if (previewFileVisual) {
                return <span className="text-xs inline-flex" style={{ color: previewFileVisual.color }}>{previewFileVisual.icon}</span>;
              }
              return (
                <AgentIcon
                  agentId={sessionById.get(dragPreview.tabId)?.agentId ?? "claude"}
                  size={15}
                />
              );
            })()}
            {dragPreview.tabId === SETTINGS_ID ? (
              <span className="text-xs">{t("common.settings")}</span>
            ) : (
              <span className="text-xs truncate">
                {tabsById[dragPreview.tabId]?.title ?? sessionById.get(dragPreview.tabId)?.name}
              </span>
            )}
            <CloseOutlined style={{ fontSize: 10, opacity: 0.55 }} />
          </div>,
          document.body
        )}
    </div>
  );
}

export default TabBar;
