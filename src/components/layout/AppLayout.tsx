import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Button, Layout, message, Spin } from "antd";
import dayjs from "dayjs";
import TitleBar from "./TitleBar";
import StatusBar from "./StatusBar";
import PrimarySidebarRail from "./PrimarySidebarRail";
import Sidebar from "./Sidebar";
import AuxiliaryDock from "./AuxiliaryDock";
import TabBar from "@/components/TabBar";
import HomePage from "@/pages/home";
import SessionCheckpointSummaryBar from "@/components/SessionCheckpointSummaryBar";
import { NewSessionDialog } from "@/components/NewSessionDialog";
import GlobalTextSearchDialog from "@/components/GlobalTextSearchDialog";
import { VoiceTrigger } from "@/components/VoiceButton";
import { useAppStore, type LayoutNode } from "@/store";
import { REMOTE_NOTIFICATION_PROVIDERS } from "@/lib/remoteNotifications";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useResumeSession } from "@/hooks/useResumeSession";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import {
  getClaudeCliInfo,
  ensureAgentStatusHook,
  sendSessionNotification,
  sendRemoteNotification,
  getWindowProjectContext,
  configureVoiceGlobalShortcut,
  isVoiceGlobalShortcutRegistered,
  openProjectWindow,
  spawnPty,
  resolveRecentCodexSessionId,
  checkpointListTurns,
} from "@/lib/api";
import {
  getAgentCommandShell,
  getAgentDisplayName,
  getAgentIdsWithCapability,
  isAiAgentId,
  getAgentStartupCommand,
  prepareAgentInitialPrompt,
} from "@/lib/agents";
import { detectClaudeRuntimeState } from "@/lib/runtimeDetection";
import { selectAllExplorerEntries } from "@/lib/explorer";
import i18n from "@/i18n";
import type {
  AgentId,
  AntigravitySessionLaunchOptions,
  ClaudeSessionLaunchOptions,
  NewSessionLaunchRequest,
  QoderSessionLaunchOptions,
  Session,
  SessionLaunchOptions,
  SessionUsageUpdatePayload,
  AgentTurnReview,
  AiAgentId,
} from "@/types";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { playNotificationSound } from "@/lib/sounds";
import { closeTabRuntime, confirmCloseTab } from "@/lib/tabClose";
import { toTauriShortcut } from "@/lib/shortcut";
import type { AsrPhase } from "@/hooks/useVoiceRecognition";
import { useProjectLauncher } from "@/hooks/useProjectLauncher";
import type { AgentCliInfo } from "@/types";
import {
  OPEN_GLOBAL_TEXT_SEARCH_EVENT,
  type OpenGlobalTextSearchDetail,
} from "@/lib/globalSearch";
import { getNotificationSuppressionReason } from "@/lib/attentionDiagnostics";
import { isSessionVisibleInWorkspace } from "@/lib/sessionVisibility";
import { checkpointSessionUpdates } from "@/lib/checkpointReview";
import {
  OPEN_AUXILIARY_QUESTION_EVENT,
  openAuxiliarySession,
  type OpenAuxiliaryQuestionDetail,
} from "@/lib/auxiliaryDock";
import { isSessionVisibleInAuxiliaryDock } from "@/store/auxiliaryDock";

const { Content } = Layout;
const SETTINGS_ID = "__settings__";
const TERMINAL_LAYOUT_SYNC_EVENT = "terminal:layout-sync";
const STATUS_AGENT_IDS = getAgentIdsWithCapability("statusEvents");
const MIN_SPLIT_PANE_SIZE = 320;

const SettingsPanel = lazy(() => import("@/components/SettingsPanel"));
const FileTabView = lazy(() => import("@/components/FileTabView"));
const GitDiffTabView = lazy(() => import("@/components/GitDiffTabView"));
const Terminal = lazy(() => import("@/components/Terminal"));

function WorkspaceContentFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spin size="small" />
    </div>
  );
}

function sideQuestionLaunchOptions(agentId: AiAgentId): SessionLaunchOptions | undefined {
  if (agentId === "claude") {
    return { skipPermissions: false, effort: "inherit" };
  }
  if (agentId === "codex") {
    return {
      yolo: false,
      approvalMode: "never",
      sandboxMode: "read-only",
      effort: "inherit",
    };
  }
  if (agentId === "antigravity") {
    return {
      dangerouslySkipPermissions: false,
      sandbox: true,
      mode: "plan",
    };
  }
  if (agentId === "qoder") {
    return { permissionMode: "dont_ask" };
  }
  return undefined;
}

interface WorkerVoiceStatePayload {
  phase: AsrPhase;
  level: number;
  elapsedMs: number;
  errorMessage: string | null;
  shortcutLabel: string;
  inputTarget: "terminal" | "system";
  hasGlobalShortcut: boolean;
}

interface VoiceGlobalShortcutStatusPayload {
  registered: boolean;
  shortcut: string | null;
  errorMessage: string | null;
}

interface AgentStatusUpdatePayload {
  eventId: string;
  revision: number;
  sessionId: string;
  agent: AiAgentId;
  state: "running" | "waiting" | "completed" | "error";
  eventType?: string | null;
  agentSessionId?: string | null;
  createdAt: number;
}

interface AgentHookConfigurationFailedPayload {
  sessionId: string;
  agentId: string;
  error: string;
}

const INITIAL_WORKER_VOICE_STATE: WorkerVoiceStatePayload = {
  phase: "idle",
  level: 0,
  elapsedMs: 0,
  errorMessage: null,
  shortcutLabel: "Ctrl+Shift+V",
  inputTarget: "terminal",
  hasGlobalShortcut: false,
};

function WorkspacePane({ paneId }: { paneId: string }) {
  const pane = useAppStore((state) => state.panesById[paneId]);
  const tabsById = useAppStore((state) => state.tabsById);
  const sessions = useAppStore((state) => state.sessions);
  const currentProject = useAppStore((state) => state.currentProject);
  const activePaneId = useAppStore((state) => state.activePaneId);
  const setActiveSession = useAppStore((state) => state.setActiveSession);
  const updateSession = useAppStore((state) => state.updateSession);
  const closeTab = useAppStore((state) => state.closeTab);
  const resumeSession = useResumeSession();

  if (!pane) return null;
  const activeSession = pane.activeTabId
    ? sessions.find((session) => session.id === pane.activeTabId) ?? null
    : null;

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col"
      style={{ background: "var(--cs-bg-content)" }}
      onPointerDownCapture={() => {
        if (activePaneId !== pane.id) {
          setActiveSession(pane.activeTabId, pane.id);
        }
      }}
    >
      <TabBar paneId={pane.id} tabIds={pane.tabIds} activeTabId={pane.activeTabId} />
      {activeSession && <SessionCheckpointSummaryBar session={activeSession} />}
      <div className="relative min-h-0 flex-1">
        {pane.tabIds.length === 0 ? (
          <div
            className="flex h-full items-center justify-center text-xs"
            style={{ color: "var(--cs-text-tertiary)" }}
          >
            {i18n.t("tabBar.emptyPane")}
          </div>
        ) : (
          pane.tabIds.map((tabId) => {
            const tab = tabsById[tabId];
            const isSettings = tabId === SETTINGS_ID || tab?.kind === "settings";
            const isFile = tab?.kind === "file";
            const isDiff = tab?.kind === "diff";
            const session = isSettings || isFile || isDiff
              ? null
              : sessions.find((item) => item.id === tabId);
            if (!isSettings && !isFile && !isDiff && !session) return null;

            return (
              <div
                key={tabId}
                style={{
                  display: tabId === pane.activeTabId ? "block" : "none",
                  position: "absolute",
                  inset: 0,
                }}
              >
                <Suspense fallback={<WorkspaceContentFallback />}>
                  {isSettings ? (
                    <SettingsPanel />
                  ) : isFile && currentProject ? (
                    <FileTabView
                      tabId={tabId}
                      projectPath={currentProject.path}
                      path={tab.resourceId}
                      isActive={tabId === pane.activeTabId}
                    />
                  ) : isDiff ? (
                    <GitDiffTabView tabId={tabId} />
                  ) : session?.active ? (
                    <Terminal
                      sessionId={tabId}
                      overviewNavigationId={`${pane.id}:${tabId}`}
                      onExit={() => updateSession(tabId, { active: false })}
                      onClose={() => closeTab(tabId)}
                    />
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                      <div className="text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>
                        {i18n.t("terminal.sessionDisconnected")}
                      </div>
                      <div className="max-w-md text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
                        {i18n.t("terminal.sessionDisconnectedDesc")}
                      </div>
                      <Button
                        type="primary"
                        loading={session?.status === "starting"}
                        onClick={() => void resumeSession(tabId)}
                      >
                        {i18n.t("terminal.resumeSession")}
                      </Button>
                    </div>
                  )}
                </Suspense>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function clampSplitRatioForRect(ratio: number, size: number) {
  if (!Number.isFinite(ratio)) return 0.5;
  if (size <= MIN_SPLIT_PANE_SIZE * 2) {
    return Math.min(0.8, Math.max(0.2, ratio));
  }
  const minRatio = MIN_SPLIT_PANE_SIZE / size;
  return Math.min(1 - minRatio, Math.max(minRatio, ratio));
}

function WorkspaceSplitDivider({
  direction,
  ratio,
  splitPath,
}: {
  direction: "horizontal" | "vertical";
  ratio: number;
  splitPath: number[];
}) {
  const dividerRef = useRef<HTMLDivElement>(null);
  const dragFrameRef = useRef<number | null>(null);
  const pendingDragPointRef = useRef<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const setWorkspaceSplitRatio = useAppStore((state) => state.setWorkspaceSplitRatio);
  const isHorizontal = direction === "horizontal";

  const updateRatioFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const container = dividerRef.current?.parentElement;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const size = isHorizontal ? rect.width : rect.height;
      if (size <= 0) return;
      const offset = isHorizontal ? clientX - rect.left : clientY - rect.top;
      setWorkspaceSplitRatio(splitPath, clampSplitRatioForRect(offset / size, size));
    },
    [isHorizontal, setWorkspaceSplitRatio, splitPath],
  );

  const scheduleRatioUpdate = useCallback(
    (clientX: number, clientY: number) => {
      pendingDragPointRef.current = { x: clientX, y: clientY };
      if (dragFrameRef.current !== null) return;
      dragFrameRef.current = window.requestAnimationFrame(() => {
        dragFrameRef.current = null;
        const point = pendingDragPointRef.current;
        if (!point) return;
        updateRatioFromPointer(point.x, point.y);
      });
    },
    [updateRatioFromPointer],
  );

  useEffect(() => {
    return () => {
      if (dragFrameRef.current !== null) {
        window.cancelAnimationFrame(dragFrameRef.current);
      }
    };
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      setDragging(true);
      updateRatioFromPointer(event.clientX, event.clientY);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        scheduleRatioUpdate(moveEvent.clientX, moveEvent.clientY);
      };
      const handlePointerUp = (upEvent: PointerEvent) => {
        upEvent.preventDefault();
        pendingDragPointRef.current = null;
        if (dragFrameRef.current !== null) {
          window.cancelAnimationFrame(dragFrameRef.current);
          dragFrameRef.current = null;
        }
        updateRatioFromPointer(upEvent.clientX, upEvent.clientY);
        document.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("pointerup", handlePointerUp);
        document.body.style.cursor = "";
        setDragging(false);
      };

      document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize";
      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", handlePointerUp, { once: true });
    },
    [isHorizontal, scheduleRatioUpdate, updateRatioFromPointer],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const delta = event.shiftKey ? 0.08 : 0.02;
      const decreaseKey = isHorizontal ? "ArrowLeft" : "ArrowUp";
      const increaseKey = isHorizontal ? "ArrowRight" : "ArrowDown";
      if (event.key === decreaseKey) {
        event.preventDefault();
        setWorkspaceSplitRatio(splitPath, ratio - delta);
      } else if (event.key === increaseKey) {
        event.preventDefault();
        setWorkspaceSplitRatio(splitPath, ratio + delta);
      } else if (event.key === "Home") {
        event.preventDefault();
        setWorkspaceSplitRatio(splitPath, 0.2);
      } else if (event.key === "End") {
        event.preventDefault();
        setWorkspaceSplitRatio(splitPath, 0.8);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setWorkspaceSplitRatio(splitPath, 0.5);
      }
    },
    [isHorizontal, ratio, setWorkspaceSplitRatio, splitPath],
  );

  return (
    <>
      <div
        ref={dividerRef}
        role="separator"
        aria-orientation={isHorizontal ? "vertical" : "horizontal"}
        aria-valuemin={20}
        aria-valuemax={80}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        className="app-workspace-split-divider"
        data-direction={direction}
        data-dragging={dragging ? "true" : "false"}
        onDoubleClick={() => setWorkspaceSplitRatio(splitPath, 0.5)}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
      />
      {dragging ? (
        <div
          className="fixed inset-0 z-[9999]"
          style={{ cursor: isHorizontal ? "col-resize" : "row-resize" }}
        />
      ) : null}
    </>
  );
}

function WorkspaceLayoutNode({ node, splitPath = [] }: { node: LayoutNode; splitPath?: number[] }) {
  if (node.type === "pane") {
    return <WorkspacePane paneId={node.paneId} />;
  }

  const isHorizontal = node.direction === "horizontal";
  return (
    <div
      className={`flex h-full min-h-0 min-w-0 ${isHorizontal ? "flex-row" : "flex-col"}`}
      style={{ background: "var(--cs-border-sidebar)" }}
    >
      <div
        className="min-h-0 min-w-0 overflow-hidden"
        style={{ flex: `${node.ratio} 1 0%` }}
      >
        <WorkspaceLayoutNode node={node.first} splitPath={[...splitPath, 0]} />
      </div>
      <WorkspaceSplitDivider
        direction={node.direction}
        ratio={node.ratio}
        splitPath={splitPath}
      />
      <div
        className="min-h-0 min-w-0 overflow-hidden"
        style={{ flex: `${1 - node.ratio} 1 0%` }}
      >
        <WorkspaceLayoutNode node={node.second} splitPath={[...splitPath, 1]} />
      </div>
    </div>
  );
}

function getEventDurationMs(metadata: Record<string, unknown> | undefined): number | null {
  const value = metadata?.durationMs;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function getRemoteNotificationEventType(eventType: string): "completed" | "error" | "waiting" | "permission" | null {
  if (eventType === "assistant_complete") return "completed";
  if (eventType === "permission_request") return "permission";
  if (eventType === "waiting_input" || eventType === "tool_blocked") return "waiting";
  if (eventType === "process_error" || eventType === "hook_error" || eventType === "heartbeat_timeout") {
    return "error";
  }
  return null;
}

function formatNotificationDuration(durationMs: number, locale: string): string {
  const normalizedLocale = locale.replace("_", "-");
  const minutes = Math.max(1, Math.round(durationMs / 60000));
  if (minutes >= 60) {
    return new Intl.NumberFormat(normalizedLocale, {
      style: "unit",
      unit: "hour",
      unitDisplay: "short",
      maximumFractionDigits: 1,
    }).format(minutes / 60);
  }
  return new Intl.NumberFormat(normalizedLocale, {
    style: "unit",
    unit: "minute",
    unitDisplay: "short",
  }).format(minutes);
}

function AppLayout() {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessions = useAppStore((s) => s.sessions);
  const tabsById = useAppStore((s) => s.tabsById);
  const panesById = useAppStore((s) => s.panesById);
  const workspaceLayout = useAppStore((s) => s.layout);
  const currentProject = useAppStore((s) => s.currentProject);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const activeSidebarSection = useAppStore((s) => s.activeSidebarSection);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const updateSession = useAppStore((s) => s.updateSession);
  const closeTab = useAppStore((s) => s.closeTab);
  const pushSessionEvent = useAppStore((s) => s.pushSessionEvent);
  const focusSessionFromEvent = useAppStore((s) => s.focusSessionFromEvent);
  const notificationEnabled = useAppStore((s) => s.notificationEnabled);
  const soundEnabled = useAppStore((s) => s.notificationSoundEnabled);
  const soundMap = useAppStore((s) => s.notificationSoundMap);
  const notificationThresholdMs = useAppStore((s) => s.notificationThresholdMs);
  const remoteNotificationChannels = useAppStore((s) => s.remoteNotificationChannels);
  const windowContextReady = useAppStore((s) => s.windowContextReady);
  const windowMode = useAppStore((s) => s.windowMode);
  const windowLabel = useAppStore((s) => s.windowLabel);
  const startupRestoreLastProject = useAppStore((s) => s.startupRestoreLastProject);
  const lastProjectPath = useAppStore((s) => s.lastProject?.path ?? null);
  const setClaudeCliInfo = useAppStore((s) => s.setClaudeCliInfo);
  const initializeWindowContext = useAppStore((s) => s.initializeWindowContext);
  const voiceTriggerVisible = useAppStore((s) => s.voiceTriggerVisible);
  const setVoiceTriggerVisible = useAppStore((s) => s.setVoiceTriggerVisible);
  const addSession = useAppStore((s) => s.addSession);
  const removeSession = useAppStore((s) => s.removeSession);
  const setAgentPermissionDefaults = useAppStore((s) => s.setAgentPermissionDefaults);
  const defaultTerminalShell = useAppStore((s) => s.defaultTerminalShell);
  const { handleOpenFolder } = useProjectLauncher();
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionTarget, setNewSessionTarget] = useState<"workspace" | "auxiliary">("workspace");
  const [creatingSession, setCreatingSession] = useState(false);
  const [globalTextSearchState, setGlobalTextSearchState] = useState<{
    open: boolean;
    scopePath: string | null;
  }>({ open: false, scopePath: null });

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const visibleTerminalSessionKey = Object.values(panesById)
    .map((pane) => pane.activeTabId)
    .filter((tabId): tabId is string => Boolean(tabId && tabsById[tabId]?.kind === "session"))
    .sort()
    .join("\u0000");
  const workspaceLayoutKey = JSON.stringify(workspaceLayout.root);
  const settingsVisible = Object.values(panesById).some((pane) => {
    const activeTabId = pane.activeTabId;
    return activeTabId === SETTINGS_ID || tabsById[activeTabId ?? ""]?.kind === "settings";
  });
  const restoreAttemptedLastProjectPathRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const agentId of STATUS_AGENT_IDS) {
        try {
          const status = await ensureAgentStatusHook(agentId);
          useAppStore.getState().setAgentHookDiagnostic({
            agentId,
            configured: status.configured,
            configPath: status.configPath,
            detail: status.detail ?? undefined,
            checkedAt: Date.now(),
          });
          if (!status.configured) {
            const errorText = status.detail
              ?? i18n.t("settings.hooks.integrityCheckFailed", { path: status.configPath });
            void message.warning({
              content: i18n.t("settings.hooks.autoInstallFailed", {
                agent: getAgentDisplayName(agentId),
                error: errorText,
              }),
              key: `agent-hook-install-${agentId}`,
              duration: 8,
            });
          }
        } catch (error) {
          if (!cancelled) {
            console.warn(`Failed to preinstall ${agentId} status hook:`, error);
            const errorText = error instanceof Error ? error.message : String(error);
            useAppStore.getState().setAgentHookDiagnostic({
              agentId,
              configured: false,
              checkedAt: Date.now(),
              error: errorText,
            });
            void message.warning({
              content: i18n.t("settings.hooks.autoInstallFailed", {
                agent: getAgentDisplayName(agentId),
                error: errorText,
              }),
              key: `agent-hook-install-${agentId}`,
              duration: 8,
            });
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<AgentHookConfigurationFailedPayload>(
      "agent-hook-configuration-failed",
      (event) => {
        const { agentId, error } = event.payload;
        if (isAiAgentId(agentId)) {
          useAppStore.getState().setAgentHookDiagnostic({
            agentId,
            configured: false,
            checkedAt: Date.now(),
            error,
          });
        }
        void message.warning({
          content: i18n.t("settings.hooks.sessionInstallFailed", {
            agent: isAiAgentId(agentId) ? getAgentDisplayName(agentId) : agentId,
            error,
          }),
          key: `agent-hook-install-${agentId}`,
          duration: 10,
        });
      }
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  const handleExit = useCallback(
    (sessionId: string) => {
      updateSession(sessionId, { active: false });
    },
    [updateSession]
  );

  const handleRequestCloseTab = useCallback(
    async (tabId: string) => {
      const tab = useAppStore.getState().tabsById[tabId];
      const canClose = await confirmCloseTab(tab, i18n.t.bind(i18n));
      if (canClose) {
        await closeTabRuntime(tab);
        closeTab(tabId);
      }
    },
    [closeTab]
  );

  const handleNewSession = useCallback(() => {
    if (currentProject) {
      setNewSessionTarget("workspace");
      setNewSessionOpen(true);
    } else {
      void handleOpenFolder();
    }
  }, [currentProject, handleOpenFolder]);

  const handleCreateSession = useCallback(
    async (
      name: string,
      agent: AgentCliInfo,
      launchOptions?: SessionLaunchOptions,
      titleSource: Session["titleSource"] = "manual",
      closeDialog = true,
      presentation: "workspace" | "auxiliary" = "workspace",
      initialPrompt?: string,
      rememberPermissionDefaults = true,
    ): Promise<string | null> => {
      if (!currentProject || creatingSession) return null;
      setCreatingSession(true);
      const sessionId = crypto.randomUUID();
      const sessionCreatedAt = Date.now();
      const isClaude = agent.id === "claude";
      const claudeOptions = isClaude ? (launchOptions as ClaudeSessionLaunchOptions | undefined) : undefined;
      const claudeSkipPermissions = isClaude
        ? (claudeOptions?.skipPermissions ?? false)
        : false;
      const claudeEffort = isClaude && claudeOptions?.effort !== "inherit"
        ? claudeOptions?.effort ?? null
        : null;
      const antigravityOptions = agent.id === "antigravity"
        ? (launchOptions as AntigravitySessionLaunchOptions | undefined)
        : undefined;
      const qoderOptions = agent.id === "qoder"
        ? (launchOptions as QoderSessionLaunchOptions | undefined)
        : undefined;
      const providerInitialPrompt = prepareAgentInitialPrompt(agent.id, initialPrompt);

      addSession({
        id: sessionId,
        path: currentProject.path,
        name,
        createdAt: sessionCreatedAt,
        active: false,
        hasPromptHistory: Boolean(providerInitialPrompt),
        status: "starting",
        titleSource,
        agentId: agent.id,
        agentExecutablePath: agent.executablePath,
        presentation,
        runtimeEffort: claudeEffort,
        claudeSkipPermissions: agent.id === "claude" ? claudeSkipPermissions : null,
        antigravityDangerouslySkipPermissions:
          agent.id === "antigravity" ? antigravityOptions?.dangerouslySkipPermissions ?? false : null,
        antigravitySandbox:
          agent.id === "antigravity" ? antigravityOptions?.sandbox ?? false : null,
        antigravityMode:
          agent.id === "antigravity" ? antigravityOptions?.mode ?? "inherit" : null,
        qoderPermissionMode:
          agent.id === "qoder" ? qoderOptions?.permissionMode ?? "inherit" : null,
      }, { openInWorkspace: presentation === "workspace" });

      try {
        await spawnPty(
          sessionId,
          currentProject.path,
          false,
          claudeSkipPermissions,
          getAgentStartupCommand(agent.id, agent.executablePath, null, providerInitialPrompt, launchOptions),
          providerInitialPrompt,
          getAgentCommandShell(agent.id),
          claudeEffort ?? undefined,
          agent.id,
        );
        if (closeDialog) setNewSessionOpen(false);
        if (rememberPermissionDefaults) {
          setAgentPermissionDefaults(agent.id, launchOptions);
        }
        updateSession(sessionId, {
          active: true,
          status: agent.id === "opencode" && providerInitialPrompt ? "running" : "waiting",
        });
        if (presentation === "auxiliary") {
          openAuxiliarySession({
            sessionId,
            projectPath: currentProject.path,
            title: name,
            kind: "task",
          });
        }
        if (agent.id === "codex") {
          const codexSessionId = await resolveRecentCodexSessionId(
            currentProject.path,
            sessionCreatedAt,
          );
          if (codexSessionId) {
            updateSession(sessionId, { agentSessionId: codexSessionId });
          }
        }
        return sessionId;
      } catch (error) {
        console.error(`Failed to start ${agent.name} session:`, error);
        removeSession(sessionId);
        void message.error(
          `${i18n.t("newSession.createFailed")}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      } finally {
        setCreatingSession(false);
      }
    },
    [addSession, creatingSession, currentProject, defaultTerminalShell, removeSession, setAgentPermissionDefaults, updateSession],
  );

  const handleOpenSideQuestion = useCallback(
    async ({ agent, prompt, question }: OpenAuxiliaryQuestionDetail) => {
      const compactQuestion = question.replace(/\s+/g, " ").trim();
      const name = i18n.t("auxiliaryDock.questionTaskName", {
        question: compactQuestion.length > 42
          ? `${compactQuestion.slice(0, 42)}…`
          : compactQuestion,
      });
      const sessionId = await handleCreateSession(
        name,
        agent,
        sideQuestionLaunchOptions(agent.id),
        "default",
        false,
        "auxiliary",
        prompt,
        false,
      );
      return Boolean(sessionId);
    },
    [handleCreateSession],
  );

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<OpenAuxiliaryQuestionDetail>).detail;
      if (!detail || detail.projectPath !== currentProject?.path) return;
      void handleOpenSideQuestion(detail);
    };
    window.addEventListener(OPEN_AUXILIARY_QUESTION_EVENT, handler);
    return () => window.removeEventListener(OPEN_AUXILIARY_QUESTION_EVENT, handler);
  }, [currentProject?.path, handleOpenSideQuestion]);

  const handleCreateTerminal = useCallback(
    async (
      shell: "powershell" | "cmd",
      presentation: "workspace" | "auxiliary" = "workspace",
    ) => {
      if (!currentProject || creatingSession) return;
      setCreatingSession(true);
      const sessionId = crypto.randomUUID();
      const shellName = i18n.t(`newSessionMenu.${shell}`);
      const sessionName = `${shellName} ${dayjs().format("HH:mm:ss")}`;

      addSession({
        id: sessionId,
        path: currentProject.path,
        name: sessionName,
        createdAt: Date.now(),
        active: false,
        ephemeral: true,
        hasPromptHistory: false,
        status: "starting",
        titleSource: "default",
        agentId: shell as AgentId,
        agentExecutablePath: null,
        presentation,
      }, { openInWorkspace: presentation === "workspace" });

      try {
        await spawnPty(
          sessionId,
          currentProject.path,
          false,
          false,
          "",
          undefined,
          shell,
          undefined,
          shell,
        );
        updateSession(sessionId, { active: true, status: "waiting" });
        if (presentation === "auxiliary") {
          openAuxiliarySession({
            sessionId,
            projectPath: currentProject.path,
            title: sessionName,
            kind: "terminal",
          });
        }
      } catch (error) {
        console.error(`Failed to start ${shellName}:`, error);
        removeSession(sessionId);
        void message.error(
          `${i18n.t("newSession.createFailed")}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        setCreatingSession(false);
      }
    },
    [addSession, creatingSession, currentProject, removeSession, updateSession],
  );

  useEffect(() => {
    const handler = () => handleNewSession();
    window.addEventListener("shortcut:new-session", handler);
    return () => window.removeEventListener("shortcut:new-session", handler);
  }, [handleNewSession]);

  useEffect(() => {
    const handler = (event: Event) => {
      const request = (event as CustomEvent<NewSessionLaunchRequest>).detail;
      if (request.kind === "terminal") {
        void handleCreateTerminal(request.shell);
        return;
      }
      void handleCreateSession(
        `${request.agent.name} ${dayjs().format("HH:mm:ss")}`,
        request.agent,
        request.launchOptions,
        "default",
        false,
        "workspace",
      );
    };
    window.addEventListener("session:create-request", handler);
    return () => window.removeEventListener("session:create-request", handler);
  }, [handleCreateSession, handleCreateTerminal]);

  const handleToggleSidebar = useCallback(() => {
    toggleSidebar();
  }, [toggleSidebar]);

  const handleOpenGlobalTextSearch = useCallback(() => {
    if (currentProject) {
      setGlobalTextSearchState({ open: true, scopePath: null });
    }
  }, [currentProject]);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      if (!currentProject) return;
      const detail = (event as CustomEvent<OpenGlobalTextSearchDetail>).detail;
      setGlobalTextSearchState({
        open: true,
        scopePath: detail?.scopePath ?? null,
      });
    };
    window.addEventListener(OPEN_GLOBAL_TEXT_SEARCH_EVENT, handleOpen);
    return () => window.removeEventListener(OPEN_GLOBAL_TEXT_SEARCH_EVENT, handleOpen);
  }, [currentProject]);

  const handleSelectAllExplorer = useCallback(() => {
    selectAllExplorerEntries();
  }, []);

  const handleVoiceShortcutPress = useCallback(() => {
    void emit("voice-worker-control", { action: "press" });
  }, []);

  const handleVoiceShortcutRelease = useCallback(() => {
    void emit("voice-worker-control", { action: "release" });
  }, []);
  const asrApiKey = useAppStore((s) => s.asrApiKey);
  const asrAuthMode = useAppStore((s) => s.asrAuthMode);
  const asrModel = useAppStore((s) => s.asrModel);
  const asrRegion = useAppStore((s) => s.asrRegion);
  const voiceShortcut = useAppStore((s) => s.voiceShortcut);
  const voiceInputTarget = useAppStore((s) => s.voiceInputTarget);
  const [hasGlobalVoiceShortcut, setHasGlobalVoiceShortcut] = useState(false);
  const [workerVoiceState, setWorkerVoiceState] = useState<WorkerVoiceStatePayload>(
    INITIAL_WORKER_VOICE_STATE,
  );

  const handleVoiceTrigger = useCallback(() => {
    void emit("voice-worker-control", { action: "toggle" });
  }, []);

  const handleHideVoiceTrigger = useCallback(() => {
    setVoiceTriggerVisible(false);
    void message.info(
      i18n.t("settings.voiceRecognition.triggerHidden", {
        defaultValue: "已隐藏语音输入；可在“设置 > 语音识别 > 麦克风图标”中重新显示。",
      }),
    );
  }, [setVoiceTriggerVisible]);

  useEffect(() => {
    const payload = {
      apiKey: asrApiKey,
      authMode: asrAuthMode,
      model: asrModel,
      region: asrRegion,
      shortcut: voiceShortcut,
      inputTarget: voiceInputTarget,
    };
    void emit("voice-worker-config", payload).catch(() => undefined);
  }, [asrApiKey, asrAuthMode, asrModel, asrRegion, voiceInputTarget, voiceShortcut]);
  useEffect(() => {
    const unlistenPromise = listen<{ text: string }>("voice-worker-result", (event) => {
      const text = event.payload?.text;
      if (!text?.trim()) {
        return;
      }

      const state = useAppStore.getState();
      const activeSessionId = state.activeSessionId;
      const activeSession = activeSessionId
        ? state.sessions.find((session) => session.id === activeSessionId)
        : null;
      const shouldWriteToTerminal = document.hasFocus() && !!activeSession && activeSession.active && activeSession.status !== "starting";

      if (shouldWriteToTerminal && activeSessionId) {
        void emit("voice-terminal-input", { sessionId: activeSessionId, text });
      }
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);


  useEffect(() => {
    const unlistenPromise = listen<WorkerVoiceStatePayload>("voice-worker-state", (event) => {
      setWorkerVoiceState(event.payload);
    });

    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<{ code: string; message: string }>("voice-worker-error", (event) => {
      const err = event.payload;
      if (err.code === "no_api_key") {
        void message.warning(err.message);
      } else if (err.code === "empty_audio") {
        void message.info(err.message);
      } else if (err.code === "shortcut_register_failed") {
        void message.warning({
          key: "voice-shortcut-register-failed",
          content: err.message,
        });
      } else {
        void message.error(err.message);
      }
    });

    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<VoiceGlobalShortcutStatusPayload>(
      "voice-global-shortcut-state",
      (event) => {
        const payload = event.payload;
        setHasGlobalVoiceShortcut(payload.registered);
        if (payload.errorMessage) {
          void message.warning({
            key: "voice-shortcut-register-failed",
            content: payload.errorMessage,
          });
        }
      }
    );

    void isVoiceGlobalShortcutRegistered()
      .then((registered) => {
        setHasGlobalVoiceShortcut(registered);
      })
      .catch(() => {
        setHasGlobalVoiceShortcut(false);
      });

    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const accelerator = toTauriShortcut(voiceShortcut);

    void configureVoiceGlobalShortcut(accelerator, Boolean(voiceShortcut.trim()))
      .then((registered) => {
        if (!disposed) {
          setHasGlobalVoiceShortcut(registered);
        }
      })
      .catch((error) => {
        console.warn("voice global shortcut registration failed:", error);
        if (!disposed) {
          setHasGlobalVoiceShortcut(false);
          void message.warning({
            key: "voice-shortcut-register-failed",
            content:
              error instanceof Error && error.message
                ? error.message
                : `语音快捷键 ${voiceShortcut} 注册失败，已回退为窗口内快捷键`,
          });
        }
      });

    return () => {
      disposed = true;
    };
  }, [voiceShortcut]);

  useKeyboardShortcuts({
    onNewSession: handleNewSession,
    onToggleSidebar: handleToggleSidebar,
    onGlobalTextSearch: handleOpenGlobalTextSearch,
    onRequestCloseTab: (tabId) => {
      void handleRequestCloseTab(tabId);
    },
    onSelectAllExplorer: handleSelectAllExplorer,
    onVoiceShortcutPress: handleVoiceShortcutPress,
    onVoiceShortcutRelease: handleVoiceShortcutRelease,
    voiceShortcut,
    enableVoiceShortcut: !hasGlobalVoiceShortcut,
  });

  useEffect(() => {
    let disposed = false;
    getClaudeCliInfo()
      .then((info) => {
        if (!disposed) {
          setClaudeCliInfo(info);
        }
      })
      .catch((error) => {
        if (!disposed) {
          setClaudeCliInfo({
            available: false,
            version: null,
            executablePath: null,
            checkedAt: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      disposed = true;
    };
  }, [setClaudeCliInfo]);

  useEffect(() => {
    let disposed = false;
    getWindowProjectContext()
      .then((context) => {
        if (!disposed) initializeWindowContext(context);
      })
      .catch(console.error);

    const unlistenPromise = getCurrentWindow().listen<any>("window-context-updated", (event) => {
      initializeWindowContext(event.payload);
    });

    return () => {
      disposed = true;
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, [initializeWindowContext]);

  // Restore after both the window context and persisted settings are ready.
  useEffect(() => {
    if (
      !windowContextReady ||
      windowMode !== "launcher" ||
      windowLabel !== "main" ||
      !startupRestoreLastProject ||
      !lastProjectPath ||
      currentProject
    ) {
      return;
    }

    if (restoreAttemptedLastProjectPathRef.current === lastProjectPath) {
      return;
    }

    restoreAttemptedLastProjectPathRef.current = lastProjectPath;
    const timer = window.setTimeout(() => {
      const state = useAppStore.getState();
      if (
        state.windowMode !== "launcher" ||
        state.windowLabel !== "main" ||
        state.currentProject ||
        !state.startupRestoreLastProject ||
        state.lastProject?.path !== lastProjectPath
      ) {
        return;
      }

      openProjectWindow(lastProjectPath, "auto").catch((error) => {
        console.error("Failed to restore last project on startup:", error);
      });
    }, 100);

    return () => window.clearTimeout(timer);
  }, [
    currentProject,
    lastProjectPath,
    startupRestoreLastProject,
    windowContextReady,
    windowLabel,
    windowMode,
  ]);

  useEffect(() => {
    const startedUnlistenPromise = listen<AgentTurnReview>("checkpoint-turn-started", (event) => {
      const turn = event.payload;
      updateSession(turn.sessionId, {
        checkpointActiveTurnId: turn.id,
        checkpointReviewStatus: "running",
        checkpointUpdatedAt: turn.updatedAt,
        checkpointWarning: null,
      });
    });
    const unlistenPromise = listen<AgentTurnReview>("checkpoint-review-ready", (event) => {
      const review = event.payload;
      const session = useAppStore
        .getState()
        .sessions.find((item) => item.id === review.sessionId);
      if (!session) return;

      checkpointListTurns(review.projectPath, review.sessionId)
        .then((turns) => {
          updateSession(review.sessionId, {
            ...checkpointSessionUpdates(turns),
            checkpointActiveTurnId: null,
            checkpointWarning: null,
          });
        })
        .catch((error) => {
          console.error("Failed to refresh checkpoint review summary:", error);
          updateSession(review.sessionId, {
            checkpointActiveTurnId: null,
            checkpointPendingTurns:
              review.reviewStatus === "awaiting_review" ||
              review.reviewStatus === "partially_reviewed"
                ? Math.max(1, session.checkpointPendingTurns ?? 0)
                : session.checkpointPendingTurns ?? 0,
            checkpointFileCount: review.files.length,
            checkpointInsertions: review.insertions,
            checkpointDeletions: review.deletions,
            checkpointReviewStatus: review.reviewStatus,
            checkpointUpdatedAt: review.updatedAt,
          });
        });
    });

    return () => {
      startedUnlistenPromise.then((fn) => fn()).catch(() => {});
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, [updateSession]);

  useEffect(() => {
    const unlistenPromise = listen<AgentStatusUpdatePayload>("agent-status", (event) => {
      const payload = event.payload;
      const session = useAppStore.getState().sessions.find((item) => item.id === payload.sessionId);
      if (!session) return;
      if (session.agentId && session.agentId !== payload.agent) return;
      if (
        Number.isFinite(payload.revision) &&
        payload.revision <= (session.statusRevision ?? 0)
      ) {
        useAppStore.getState().recordAttentionEventDiagnostic({
          eventId: `status:${payload.sessionId}:${payload.revision}`,
          sessionId: payload.sessionId,
          eventType: payload.eventType ?? `agent_status:${payload.state}`,
          source: payload.agent,
          revision: payload.revision,
          createdAt: payload.createdAt,
          receivedAt: Date.now(),
          outcome: "stale",
          requiresAttention: false,
          foreground: false,
        });
        return;
      }
      const latestObservedAt = Math.max(
        session.statusUpdatedAt ?? 0,
        session.lastEventAt ?? 0,
      );
      if (payload.createdAt < latestObservedAt) {
        useAppStore.getState().recordAttentionEventDiagnostic({
          eventId: `status:${payload.sessionId}:${payload.revision}`,
          sessionId: payload.sessionId,
          eventType: payload.eventType ?? `agent_status:${payload.state}`,
          source: payload.agent,
          revision: payload.revision,
          createdAt: payload.createdAt,
          receivedAt: Date.now(),
          outcome: "stale",
          requiresAttention: false,
          foreground: false,
        });
        return;
      }
      updateSession(payload.sessionId, {
        status: payload.state,
        active: true,
        statusRevision: payload.revision,
        statusUpdatedAt: payload.createdAt,
        ...(payload.agentSessionId ? { agentSessionId: payload.agentSessionId } : {}),
      });
      useAppStore.getState().recordAttentionEventDiagnostic({
        eventId: `status:${payload.sessionId}:${payload.revision}`,
        sessionId: payload.sessionId,
        eventType: payload.eventType ?? `agent_status:${payload.state}`,
        source: payload.agent,
        revision: payload.revision,
        createdAt: payload.createdAt,
        receivedAt: Date.now(),
        outcome: "accepted",
        requiresAttention: false,
        foreground: false,
      });
    });

    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, [updateSession]);

  useEffect(() => {
    const unlistenPromise = listen<{ session_id: string; data: string }>("pty-output", (event) => {
      const sessionId = event.payload.session_id;
      const detected = detectClaudeRuntimeState(event.payload.data);
      if (!detected) return;

      const currentSession = useAppStore.getState().sessions.find((session) => session.id === sessionId);
      if (!currentSession) return;

      const updates: Record<string, unknown> = {};
      let changed = false;

      if (detected.model !== undefined && detected.model !== currentSession.runtimeModel) {
        updates.runtimeModel = detected.model;
        changed = true;
      }
      if (detected.mode !== undefined && detected.mode !== currentSession.runtimeMode) {
        updates.runtimeMode = detected.mode;
        changed = true;
      }
      if (detected.silent !== undefined && detected.silent !== currentSession.runtimeSilent) {
        updates.runtimeSilent = detected.silent;
        changed = true;
      }

      if (!changed) return;

      updates.runtimeDetectionSource = "pty";
      updates.runtimeUpdatedAt = Date.now();
      updateSession(sessionId, updates);
    });

    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, [updateSession]);

  useEffect(() => {
    const unlistenPromise = listen<SessionUsageUpdatePayload>("session-usage-update", (event) => {
      const payload = event.payload;
      const sessionId = payload.sessionId;
      const currentSession = useAppStore
        .getState()
        .sessions.find((session) => session.id === sessionId);
      if (!currentSession) return;

      updateSession(sessionId, {
        contextUsage: {
          usedTokens: payload.usedTokens,
          totalTokens: payload.contextWindow,
          ratio: payload.usageRatio,
          model: payload.model ?? currentSession.contextUsage?.model ?? currentSession.runtimeModel ?? null,
          usageSource: payload.usageSource,
          contextWindowSource: payload.contextWindowSource,
          updatedAt: payload.updatedAt,
        },
        runtimeModel:
          payload.model && payload.model !== currentSession.runtimeModel
            ? payload.model
            : currentSession.runtimeModel,
        runtimeUpdatedAt: payload.updatedAt,
      });
    });

    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, [updateSession]);

  useEffect(() => {
    const unlistenPromise = getCurrentWindow().listen<any>("focus-session-request", (event) => {
      const payload = event.payload as { sessionId?: string; session_id?: string; projectPath?: string; project_path?: string };
      const sessionId = payload.sessionId ?? payload.session_id;
      const projectPath = payload.projectPath ?? payload.project_path;
      if (!sessionId || !projectPath) return;

      // Side tasks have their own presentation surface. A permission/input
      // notification must reveal that surface, rather than opening a second
      // copy of the terminal in the main workspace (and potentially its
      // active split pane).
      const targetSession = useAppStore
        .getState()
        .projectSessions[projectPath]
        ?.find((session) => session.id === sessionId);
      if (targetSession?.presentation === "auxiliary") {
        openAuxiliarySession({
          sessionId: targetSession.id,
          projectPath: targetSession.path,
          title: targetSession.name,
          kind: targetSession.ephemeral ? "terminal" : "task",
        });
        getCurrentWindow().setFocus().catch(() => {});
        return;
      }

      focusSessionFromEvent({
        id: `focus-${Date.now()}`,
        sessionId,
        projectPath,
        sessionName: sessionId,
        eventType: "waiting_input",
        title: "",
        body: "",
        severity: "info",
        source: "runtime",
        requiresAttention: false,
        actionable: true,
        createdAt: Date.now(),
      });
      getCurrentWindow().setFocus().catch(() => {});
    });

    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, [focusSessionFromEvent]);

  useEffect(() => {
    const unlistenPromise = listen<any>("session-event", (event) => {
      const payload = event.payload;
      const normalized = {
        id: payload.id,
        revision: payload.revision ?? null,
        sessionId: payload.sessionId ?? payload.session_id,
        projectPath: payload.projectPath ?? payload.project_path,
        sessionName: payload.sessionName ?? payload.session_name,
        eventType: payload.eventType ?? payload.event_type,
        title: payload.title,
        body: payload.body,
        severity: payload.severity,
        source: payload.source,
        requiresAttention: payload.requiresAttention ?? payload.requires_attention,
        actionable: payload.actionable,
        dedupeKey: payload.dedupeKey ?? payload.dedupe_key,
        createdAt: payload.createdAt ?? payload.created_at,
        metadata: payload.metadata ?? {},
        read: false,
        observedAtDelivery: false,
      };
      const storeState = useAppStore.getState();
      const belongsToWindow =
        storeState.currentProject?.path === normalized.projectPath ||
        storeState.sessions.some((session) => session.id === normalized.sessionId);
      if (!belongsToWindow) return;
      const targetSessionVisible =
        isSessionVisibleInAuxiliaryDock(normalized.sessionId) ||
        isSessionVisibleInWorkspace(normalized.sessionId, {
          activeSessionId: storeState.activeSessionId,
          layout: storeState.layout,
          panesById: storeState.panesById,
          tabsById: storeState.tabsById,
        });
      normalized.read =
        !normalized.requiresAttention ||
        (document.visibilityState === "visible" &&
          document.hasFocus() &&
          targetSessionVisible);
      normalized.observedAtDelivery = normalized.requiresAttention && normalized.read;
      const ingestResult = pushSessionEvent(normalized);
      const foreground = normalized.requiresAttention && normalized.read;
      useAppStore.getState().recordAttentionEventDiagnostic({
        eventId: normalized.id,
        sessionId: normalized.sessionId,
        eventType: normalized.eventType,
        source: normalized.source,
        revision: normalized.revision,
        createdAt: normalized.createdAt,
        receivedAt: Date.now(),
        outcome: ingestResult,
        requiresAttention: normalized.requiresAttention,
        foreground,
      });
      if (ingestResult !== "accepted") return;
      if (!normalized.requiresAttention) return;
      if (normalized.eventType === "process_exit") return;
      const durationMs = getEventDurationMs(normalized.metadata);
      const session = storeState.sessions.find((item) => item.id === normalized.sessionId);
      const projectFolder = normalized.projectPath
        .split(/[\\/]/)
        .filter(Boolean)
        .pop();
      const sessionLabel = session?.name ?? normalized.sessionName ?? "Termflow";
      const systemSuppressionReason = getNotificationSuppressionReason({
          enabled: notificationEnabled,
          foreground,
          // 完成通知必须有 Hook 生命周期提供的实际耗时，两个渠道遵循同一规则。
          eventType: normalized.eventType,
        durationMs,
        completionThresholdMs: notificationThresholdMs,
      });

      if (systemSuppressionReason) {
        useAppStore.getState().recordNotificationDelivery({
          channel: "system",
          eventId: normalized.id,
          eventType: normalized.eventType,
          status: "suppressed",
          reason: systemSuppressionReason,
          updatedAt: Date.now(),
        });
      } else {
        if (soundEnabled) {
          const soundType =
            normalized.eventType === "assistant_complete"
              ? soundMap.taskComplete
              : normalized.eventType === "process_error" ||
                  normalized.eventType === "process_exit" ||
                  normalized.eventType === "hook_error"
                ? soundMap.error
                : soundMap.waiting;
          playNotificationSound(soundType);
        }
        isPermissionGranted()
          .then((granted) => (granted ? "granted" : requestPermission()))
          .then((permission) => {
            if (permission !== "granted") {
              console.warn("Notification permission is not granted:", permission);
              useAppStore.getState().recordNotificationDelivery({
                channel: "system",
                eventId: normalized.id,
                eventType: normalized.eventType,
                status: "suppressed",
                reason: "permission-denied",
                updatedAt: Date.now(),
              });
              message.warning(i18n.t("settings.general.permissionDeniedWarning"));
              return;
            }
            const notificationBody = projectFolder
              ? `${sessionLabel} · ${projectFolder}`
              : sessionLabel;
            return sendSessionNotification(
              normalized.title,
              notificationBody,
              normalized.sessionId,
              normalized.projectPath
            ).then(() => {
              useAppStore.getState().recordNotificationDelivery({
                channel: "system",
                eventId: normalized.id,
                eventType: normalized.eventType,
                status: "sent",
                updatedAt: Date.now(),
              });
            });
          })
          .catch((error) => {
            const messageText = error instanceof Error ? error.message : String(error);
            console.warn("Failed to send session notification:", error);
            useAppStore.getState().recordNotificationDelivery({
              channel: "system",
              eventId: normalized.id,
              eventType: normalized.eventType,
              status: "failed",
              error: messageText,
              updatedAt: Date.now(),
            });
            message.warning(
              i18n.t("settings.general.notificationSendFailed", { error: messageText })
            );
          });
      }

      const remoteEventType = getRemoteNotificationEventType(normalized.eventType);
      if (remoteEventType) {
        const agentLabel =
          session?.agentId && isAiAgentId(session.agentId)
            ? getAgentDisplayName(session.agentId)
            : normalized.source || "Termflow";
        const fields = [
          { label: i18n.t("settings.notifications.feishu.card.project"), value: projectFolder ?? normalized.projectPath },
          { label: i18n.t("settings.notifications.feishu.card.task"), value: sessionLabel },
          { label: i18n.t("settings.notifications.feishu.card.agent"), value: agentLabel },
        ];
        if (durationMs !== null) {
          fields.push({
            label: i18n.t("settings.notifications.feishu.card.duration"),
            value: formatNotificationDuration(durationMs, i18n.language),
          });
        }
        fields.push({
          label: i18n.t("settings.notifications.feishu.card.occurredAt"),
          value: new Intl.DateTimeFormat(i18n.language.replace("_", "-"), {
            dateStyle: "short",
            timeStyle: "short",
          }).format(new Date(normalized.createdAt)),
        });

        for (const { id: provider, supported } of REMOTE_NOTIFICATION_PROVIDERS) {
          const channel = remoteNotificationChannels[provider];
          if (!supported || !channel.enabled || !channel.events[remoteEventType]) continue;
          const suppressionReason = getNotificationSuppressionReason({
            enabled: true,
            foreground,
            // Remote notifications should reach the recipient even when the
            // completed session is currently visible in this window.
            suppressWhenForeground: false,
            eventType: normalized.eventType,
            durationMs,
            completionThresholdMs: channel.thresholdMs,
          });
          if (suppressionReason) {
            useAppStore.getState().recordNotificationDelivery({
              channel: provider,
              eventId: normalized.id,
              eventType: normalized.eventType,
              status: "suppressed",
              reason: suppressionReason,
              updatedAt: Date.now(),
            });
            continue;
          }
          void sendRemoteNotification(provider, {
            eventType: remoteEventType,
            title: i18n.t(`settings.notifications.feishu.card.${remoteEventType}`),
            fields,
          })
            .then(() => {
              useAppStore.getState().recordNotificationDelivery({
                channel: provider,
                eventId: normalized.id,
                eventType: normalized.eventType,
                status: "sent",
                updatedAt: Date.now(),
              });
            })
            .catch((error: unknown) => {
              const errorText = error instanceof Error ? error.message : String(error);
              console.warn(`Failed to send ${provider} remote notification:`, error);
              useAppStore.getState().recordNotificationDelivery({
                channel: provider,
                eventId: normalized.id,
                eventType: normalized.eventType,
                status: "failed",
                error: errorText,
                updatedAt: Date.now(),
              });
            });
        }
      }    });

    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, [
    pushSessionEvent,
    notificationEnabled,
    soundEnabled,
    soundMap,
    notificationThresholdMs,
    remoteNotificationChannels,
  ]);

  useEffect(() => {
    const visibleTerminalSessionIds = visibleTerminalSessionKey
      ? visibleTerminalSessionKey.split("\u0000")
      : [];
    for (const tabId of visibleTerminalSessionIds) {
      window.dispatchEvent(
        new CustomEvent(TERMINAL_LAYOUT_SYNC_EVENT, {
          detail: {
            sessionId: tabId,
            reason: sidebarCollapsed ? "sidebar-collapsed" : "layout-updated",
          },
        })
      );
    }
  }, [sidebarCollapsed, visibleTerminalSessionKey, workspaceLayoutKey]);

  const hasTabs = Object.values(panesById).some((pane) => pane.tabIds.length > 0);
  const displayVoiceState = workerVoiceState;

  return (
    <Layout className="app-shell h-screen flex flex-col">
      <TitleBar />
      <Layout className="relative flex-1 min-h-0">
        <PrimarySidebarRail />
        <Sidebar
          collapsed={sidebarCollapsed}
          section={activeSidebarSection}
        />
        <Content className="app-main-content flex flex-col">
          <div className="app-main-stage flex min-h-0 flex-1 flex-row">
            <div className="app-main-stage-body relative min-h-0 min-w-0 flex-1">
              {windowMode === "project" && hasTabs ? (
                <WorkspaceLayoutNode node={workspaceLayout.root} />
              ) : windowMode === "project" && activeSession && activeSession.active ? (
                <Suspense fallback={<WorkspaceContentFallback />}>
                  <Terminal
                    sessionId={activeSession.id}
                    onExit={() => handleExit(activeSession.id)}
                  />
                </Suspense>
              ) : windowMode === "project" && currentProject ? (
                <HomePage />
              ) : (
                <HomePage />
              )}
              <VoiceTrigger
                visible={voiceTriggerVisible && !settingsVisible}
                onClick={handleVoiceTrigger}
                onHide={handleHideVoiceTrigger}
                shortcutLabel={voiceShortcut}
                phase={displayVoiceState.phase}
              />
            </div>
            {windowMode === "project" && currentProject ? (
              <AuxiliaryDock
                onRequestTerminal={() => {
                  void handleCreateTerminal(defaultTerminalShell, "auxiliary");
                }}
                onRequestTask={() => {
                  setNewSessionTarget("auxiliary");
                  setNewSessionOpen(true);
                }}
              />
            ) : null}
          </div>
        </Content>
      </Layout>
      <StatusBar />

      <NewSessionDialog
        open={newSessionOpen}
        creating={creatingSession}
        title={newSessionTarget === "auxiliary" ? i18n.t("auxiliaryDock.newSideTask") : undefined}
        onCancel={() => {
          if (!creatingSession) setNewSessionOpen(false);
        }}
        onCreate={(name, agent, launchOptions, titleSource) =>
          void handleCreateSession(
            name,
            agent,
            launchOptions,
            titleSource,
            true,
            newSessionTarget,
          )
        }
      />
      <GlobalTextSearchDialog
        open={globalTextSearchState.open}
        initialScopePath={globalTextSearchState.scopePath}
        onClose={() => setGlobalTextSearchState((state) => ({ ...state, open: false }))}
      />
    </Layout>
  );
}

export default AppLayout;
