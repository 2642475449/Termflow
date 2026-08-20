import type { AiAgentId, ClaudeCliInfo, GitCommitMessageProfile, ProjectOpenBehavior, Session, WindowMode, WindowProjectContext } from "@/types";

export type ThemeMode = "light-glass" | "light-warm" | "dark-starry" | "dark-mocha";
export type ThemeCategory = "light" | "dark" | "system";
export type Language = "zh_CN" | "zh_TW" | "en" | "ja";
export type NotificationSoundType =
  | "default"
  | "waiting"
  | "alert"
  | "chime"
  | "bell"
  | "glass"
  | "bloom"
  | "pebble"
  | "pulse"
  | "signal"
  | "slate"
  | "aurora"
  | "hush";
export type NotificationEvent = "taskComplete" | "error" | "waiting";
export type RemoteNotificationProvider = "feishu" | "dingtalk" | "wechat" | "qq" | "telegram";
export type RemoteNotificationEvent = "completed" | "error" | "waiting" | "permission";
export type RemoteNotificationEventMap = Record<RemoteNotificationEvent, boolean>;
export interface RemoteNotificationChannel {
  enabled: boolean;
  thresholdMs: number;
  events: RemoteNotificationEventMap;
}
export type RemoteNotificationChannels = Record<RemoteNotificationProvider, RemoteNotificationChannel>;
export type SessionRuntimeStatus = "starting" | "running" | "waiting" | "completed" | "error" | "stopped";
export type TerminalShell = "powershell" | "cmd";
export type TerminalRenderer = "webgl" | "standard";
export type SessionEventType =
  | "session_started"
  | "session_resumed"
  | "assistant_complete"
  | "waiting_input"
  | "permission_request"
  | "tool_blocked"
  | "process_exit"
  | "process_error"
  | "hook_error"
  | "heartbeat_timeout";

export type TabKind = "session" | "settings" | "diff" | "preview" | "file";
export type TabDropPosition = "before" | "after";
export type SplitDirection = "left" | "right" | "up" | "down";
export type SplitMode = "copy" | "move";

export interface SessionStreamEvent {
  id: string;
  revision?: number | null;
  sessionId: string;
  projectPath: string;
  sessionName: string;
  eventType: SessionEventType;
  title: string;
  body: string;
  severity: "info" | "success" | "warning" | "error";
  source: string;
  requiresAttention: boolean;
  actionable: boolean;
  dedupeKey?: string | null;
  createdAt: number;
  metadata?: Record<string, unknown>;
  read?: boolean;
  observedAtDelivery?: boolean;
}

export interface NotificationSoundMap {
  taskComplete: NotificationSoundType;
  error: NotificationSoundType;
  waiting: NotificationSoundType;
}

export interface TabEntity {
  id: string;
  kind: TabKind;
  resourceId: string;
  title: string;
  closable: boolean;
  pinned: boolean;
  dirty: boolean;
  preview: boolean;
  createdAt: number;
  lastActivatedAt: number;
}

export interface PaneState {
  id: string;
  tabIds: string[];
  activeTabId: string | null;
  history: string[];
}

export type LayoutNode =
  | { type: "pane"; paneId: string }
  | {
      type: "split";
      direction: "horizontal" | "vertical";
      ratio: number;
      first: LayoutNode;
      second: LayoutNode;
    };

export interface WorkspaceLayout {
  root: LayoutNode;
}

export interface DragState {
  type: "tab-reorder" | "tab-move" | "pane-split";
  sourceTabId: string;
  sourcePaneId: string;
  targetPaneId: string | null;
  targetTabId: string | null;
  position: TabDropPosition | "into-empty-pane" | null;
  phase: "pressing" | "dragging" | "dropping";
  startedAt: number;
}

export interface ResourceDragEntry {
  path: string;
  kind: "file" | "directory";
  name: string;
}

export interface ResourceDragState {
  type: "agent-resource";
  projectPath: string;
  entries: ResourceDragEntry[];
  x: number;
  y: number;
  phase: "dragging" | "dropping";
  startedAt: number;
}

export interface ProjectInfo {
  path: string;
  name: string;
}

export interface ProjectWorkspace {
  tabsById: Record<string, TabEntity>;
  panesById: Record<string, PaneState>;
  layout: WorkspaceLayout;
  activePaneId: string | null;
  focusedTabId: string | null;
}

export interface AppState {
  windowContextReady: boolean;
  windowMode: WindowMode;
  windowLabel: string;
  windowProject: ProjectInfo | null;
  lastProject: ProjectInfo | null;
  startupRestoreLastProject: boolean;
  projectOpenBehavior: ProjectOpenBehavior;
  explorerContextMenuEnabled: boolean;
  claudeCliInfo: ClaudeCliInfo | null;
  // Project
  currentProject: ProjectInfo | null;
  projectSessions: Record<string, Session[]>;
  projectWorkspaces: Record<string, ProjectWorkspace>;
  sessions: Session[];
  // Workspace snapshots for current project
  tabsById: Record<string, TabEntity>;
  panesById: Record<string, PaneState>;
  layout: WorkspaceLayout;
  activePaneId: string | null;
  focusedTabId: string | null;
  dragState: DragState | null;
  resourceDragState: ResourceDragState | null;
  // Compatibility snapshots for existing UI
  activeSessionId: string | null;
  openTabs: string[];
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  // Theme
  lightTheme: ThemeMode;
  darkTheme: ThemeMode;
  themeCategory: ThemeCategory;
  language: Language;
  systemPrefersDark: boolean;
  // Terminal
  editorFontSize: number;
  terminalFontSize: number;
  terminalCursorBlink: boolean;
  terminalLineHeight: number;
  terminalScrollback: number;
  terminalRenderer: TerminalRenderer;
  defaultTerminalShell: TerminalShell;
  defaultAgentId: AiAgentId | null;
  gitCommitMessageProfiles: GitCommitMessageProfile[];
  defaultGitCommitMessageProfileId: string;
  // Security
  skipPermissions: boolean;
  // Notification
  notificationEnabled: boolean;
  notificationSoundEnabled: boolean;
  notificationSoundMap: NotificationSoundMap;
  notificationThresholdMs: number;
  remoteNotificationChannels: RemoteNotificationChannels;
  sessionEvents: SessionStreamEvent[];
  unreadTotal: number;
  setClaudeCliInfo: (info: ClaudeCliInfo | null) => void;
  setDefaultAgentId: (agentId: AiAgentId | null) => void;
  setGitCommitMessageProfiles: (
    profiles: GitCommitMessageProfile[],
    defaultProfileId: string,
  ) => void;
  initializeWindowContext: (context: WindowProjectContext) => void;
  // Project actions
  setLastProject: (project: ProjectInfo | null) => void;
  setCurrentProject: (project: ProjectInfo) => void;
  addSession: (session: Session) => void;
  setActiveSession: (id: string | null, paneId?: string) => void;
  openTab: (tabId: string) => void;
  closeTab: (tabId: string, paneId?: string) => void;
  reorderTabs: (
    sourceTabId: string,
    targetTabId: string,
    position: TabDropPosition,
    paneId?: string
  ) => void;
  moveTab: (
    tabId: string,
    sourcePaneId: string,
    targetPaneId: string,
    targetTabId?: string | null,
    position?: TabDropPosition
  ) => void;
  splitTab: (tabId: string, direction: SplitDirection, paneId?: string, mode?: SplitMode) => void;
  setDragState: (dragState: DragState | null) => void;
  setResourceDragState: (dragState: ResourceDragState | null) => void;
  updateSession: (sessionId: string, updates: Partial<Session>) => void;
  removeSession: (sessionId: string) => void;
  removeAllSessions: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarWidth: (width: number) => void;
  toggleSidebar: () => void;
  // Theme actions
  setLightTheme: (theme: ThemeMode) => void;
  setDarkTheme: (theme: ThemeMode) => void;
  setThemeCategory: (category: ThemeCategory) => void;
  setLanguage: (lang: Language) => void;
  setSystemPrefersDark: (value: boolean) => void;
  setStartupRestoreLastProject: (enabled: boolean) => void;
  setProjectOpenBehavior: (behavior: ProjectOpenBehavior) => void;
  setExplorerContextMenuEnabled: (enabled: boolean) => void;
  // Terminal actions
  setEditorFontSize: (size: number) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalCursorBlink: (blink: boolean) => void;
  setTerminalLineHeight: (height: number) => void;
  setTerminalScrollback: (rows: number) => void;
  setTerminalRenderer: (renderer: TerminalRenderer) => void;
  setDefaultTerminalShell: (shell: TerminalShell) => void;
  // Security actions
  setSkipPermissions: (skip: boolean) => void;
  // Notification actions
  setNotificationEnabled: (enabled: boolean) => void;
  setNotificationSoundEnabled: (enabled: boolean) => void;
  setNotificationSoundMap: (event: NotificationEvent, sound: NotificationSoundType) => void;
  setNotificationThreshold: (thresholdMs: number) => void;
  setRemoteNotificationEnabled: (provider: RemoteNotificationProvider, enabled: boolean) => void;
  setRemoteNotificationThreshold: (provider: RemoteNotificationProvider, thresholdMs: number) => void;
  setRemoteNotificationEvent: (
    provider: RemoteNotificationProvider,
    event: RemoteNotificationEvent,
    enabled: boolean,
  ) => void;
  pushSessionEvent: (event: SessionStreamEvent) => "accepted" | "duplicate" | "stale";
  markSessionRead: (sessionId: string) => void;
  focusSessionFromEvent: (event: SessionStreamEvent) => void;
  activeTheme: () => ThemeMode;
}
