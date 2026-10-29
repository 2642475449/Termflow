import type {
  AiAgentId, ClaudeCliInfo, AgentPermissionDefaults, SessionLaunchOptions,
  GitCloneTask, GitCommitMessageProfile, ProjectOpenBehavior, Session,
  TerminalQuickCommand, WindowMode, WindowProjectContext,
} from "@/types";
import type { AttentionItem } from "@/lib/attention";
import type {
  AgentHookDiagnostic, AttentionDiagnostics, AttentionEventDiagnostic,
  NotificationDeliveryDiagnostic,
} from "@/lib/attentionDiagnostics";
import type { MimoAuthMode } from "@/lib/mimoAsr";
import type { RemoteNotificationProvider } from "@/lib/remoteNotifications";
import type { NetworkProxySlice } from "./slices/networkProxy";
import type { TerminalCompletionNotificationSlice } from "./slices/terminalCompletionNotification";
import type { TerminalCompletionRuntimeSlice } from "./slices/terminalCompletionRuntime";
import type { VoicePolishSlice } from "./slices/voicePolish";
import type { ProjectInfo, RecentProjectEntry } from "./utils/recentProjects";
import type { ShortcutAction, ShortcutOverrides } from "@/constants/shortcuts";

export type { ProjectInfo, RecentProjectEntry } from "./utils/recentProjects";
export type { RemoteNotificationProvider } from "@/lib/remoteNotifications";

export interface ShortcutSettingsState {
  overrides: ShortcutOverrides;
  pendingOverrides: boolean;
  recordingAction: ShortcutAction | null;
  preparing: boolean;
  setShortcut: (action: Exclude<ShortcutAction, "voiceInput">, keys: string) => void;
  setDefaultShortcut: (action?: Exclude<ShortcutAction, "voiceInput">) => void;
  setOverrides: (value: unknown) => void;
  setPersistedOverrides: (value: unknown) => void;
  setRecordingAction: (action: ShortcutAction | null) => Promise<void>;
}

export type ThemeMode = "light-glass" | "light-warm" | "dark-starry" | "dark-mocha";

export type ThemeCategory = "light" | "dark" | "system";

export type Language = "zh_CN" | "en" | "ja";

export type SidebarSection = "project" | "sessions" | "git";

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

export type RemoteNotificationEvent = "completed" | "error" | "waiting" | "permission";

export type RemoteNotificationEventMap = Record<RemoteNotificationEvent, boolean>;

export interface RemoteNotificationChannel {
  enabled: boolean;
  thresholdMs: number;
  events: RemoteNotificationEventMap;
}

export type RemoteNotificationChannels = Record<RemoteNotificationProvider, RemoteNotificationChannel>;

export type SessionRuntimeStatus = "starting" | "running" | "waiting" | "completed" | "error" | "stopped";

export type VoiceInputTarget = "terminal" | "system";

export type DashScopeRegion = "beijing" | "singapore" | "us";

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
  | "heartbeat_timeout"
  | "terminal_command_complete";

export type TabKind = "session" | "settings" | "scheduled-tasks" | "skill-market" | "diff" | "preview" | "file";

export type TabDropPosition = "before" | "after";

export type SplitDirection = "left" | "right" | "up" | "down";

export type SplitMode = "copy" | "move";

export type FileDocumentKind = "text" | "image" | "pdf" | "binary";

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

export interface FileDocumentState {
  path: string;
  name: string;
  kind: FileDocumentKind;
  readOnly: boolean;
  sizeBytes?: number | null;
  largeFile?: boolean;
  modifiedAtMs?: number | null;
}

export interface GitDiffDocumentState {
  tabId: string;
  path: string;
  oldPath?: string | null;
  name: string;
  staged: boolean;
  revision?: string | null;
  changeKind?: string | null;
  hunkActionsAvailable?: boolean;
  originalContent: string;
  modifiedContent: string;
  originalLabel: string;
  modifiedLabel: string;
  isBinary: boolean;
  contentKind?: "text" | "binary" | "gitlink" | "image";
  originalImage?: string | null;
  modifiedImage?: string | null;
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

export interface ProjectWorkspace {
  tabsById: Record<string, TabEntity>;
  panesById: Record<string, PaneState>;
  layout: WorkspaceLayout;
  activePaneId: string | null;
  focusedTabId: string | null;
}

export interface AppState
  extends NetworkProxySlice,
    TerminalCompletionNotificationSlice,
    TerminalCompletionRuntimeSlice,
    VoicePolishSlice {
  windowContextReady: boolean;
  windowMode: WindowMode;
  windowLabel: string;
  windowProject: ProjectInfo | null;
  lastProject: ProjectInfo | null;
  startupRestoreLastProject: boolean;
  projectOpenBehavior: ProjectOpenBehavior;
  explorerContextMenuEnabled: boolean;
  claudeCliInfo: ClaudeCliInfo | null;
  recentProjects: RecentProjectEntry[];
  // Project
  currentProject: ProjectInfo | null;
  projectSessions: Record<string, Session[]>;
  projectArchivedSessions: Record<string, Session[]>;
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
  fileDocuments: Record<string, FileDocumentState>;
  gitDiffDocuments: Record<string, GitDiffDocumentState>;
  // Compatibility snapshots for existing UI
  activeSessionId: string | null;
  openTabs: string[];
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  activeSidebarSection: SidebarSection;
  sidebarPinnedCollapsed: boolean;
  sidebarSessionsCollapsed: boolean;
  sidebarGitChangesCollapsed: boolean;
  sidebarGitGraphCollapsed: boolean;
  gitChangeCount: number;
  gitAheadCount: number;
  gitBehindCount: number;
  // Theme
  lightTheme: ThemeMode;
  darkTheme: ThemeMode;
  themeCategory: ThemeCategory;
  systemPrefersDark: boolean;
  language: Language;
  // Terminal
  editorFontSize: number;
  terminalFontSize: number;
  terminalCursorBlink: boolean;
  terminalLineHeight: number;
  terminalScrollback: number;
  terminalRenderer: TerminalRenderer;
  defaultTerminalShell: TerminalShell;
  // Quick Commands
  terminalQuickCommands: TerminalQuickCommand[];
  // Agents
  defaultAgentId: AiAgentId | null;
  gitCommitMessageProfiles: GitCommitMessageProfile[];
  defaultGitCommitMessageProfileId: string;
  // Security
  agentPermissionDefaults: AgentPermissionDefaults;
  // Notification
  notificationEnabled: boolean;
  notificationSoundEnabled: boolean;
  notificationSoundMap: NotificationSoundMap;
  notificationThresholdMs: number;
  remoteNotificationChannels: RemoteNotificationChannels;
  sessionEvents: SessionStreamEvent[];
  projectAttentionItems: Record<string, AttentionItem[]>;
  attentionDiagnostics: AttentionDiagnostics;
  unreadTotal: number;
  gitCloneTasks: GitCloneTask[];
  // Voice Recognition (ASR)
  asrApiKey: string;
  asrAuthMode: MimoAuthMode;
  asrModel: string;
  asrRegion: DashScopeRegion;
  voiceShortcut: string;
  voiceInputTarget: VoiceInputTarget;
  voiceTriggerVisible: boolean;
  setClaudeCliInfo: (info: ClaudeCliInfo | null) => void;
  initializeWindowContext: (context: WindowProjectContext) => void;
  // Project actions
  setRecentProjects: (projects: RecentProjectEntry[]) => void;
  setLastProject: (project: ProjectInfo | null) => void;
  setCurrentProject: (project: ProjectInfo) => void;
  addSession: (session: Session, options?: { openInWorkspace?: boolean }) => void;
  setActiveSession: (id: string | null, paneId?: string) => void;
  openTab: (tabId: string) => void;
  openFileTab: (path: string, options?: { preview?: boolean }) => string | null;
  openGitDiffTab: (
    document: Omit<GitDiffDocumentState, "tabId">,
    options?: { preview?: boolean },
  ) => string | null;
  promoteTab: (tabId: string) => void;
  closeTab: (tabId: string, paneId?: string) => void;
  registerFileDocument: (document: FileDocumentState) => void;
  setTabDirty: (tabId: string, dirty: boolean) => void;
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
  setWorkspaceSplitRatio: (splitPath: number[], ratio: number) => void;
  splitTab: (tabId: string, direction: SplitDirection, paneId?: string, mode?: SplitMode) => void;
  setDragState: (dragState: DragState | null) => void;
  setResourceDragState: (dragState: ResourceDragState | null) => void;
  updateSession: (sessionId: string, updates: Partial<Session>) => void;
  removeSession: (sessionId: string) => void;
  removeAllSessions: () => void;
  togglePinSession: (sessionId: string) => void;
  archiveSession: (sessionId: string) => void;
  unarchiveSession: (projectPath: string, sessionId: string) => void;
  deleteArchivedSession: (projectPath: string, sessionId: string) => void;
  deleteAllArchivedSessions: (projectPath: string) => void;
  archiveAllSessionsInSection: (section: "pinned" | "normal") => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarWidth: (width: number) => void;
  toggleSidebar: () => void;
  setActiveSidebarSection: (section: SidebarSection) => void;
  togglePinnedCollapsed: () => void;
  toggleSessionsCollapsed: () => void;
  setPinnedCollapsed: (collapsed: boolean) => void;
  toggleGitChangesCollapsed: () => void;
  toggleGitGraphCollapsed: () => void;
  setGitChangeCount: (count: number) => void;
  setGitSyncCounts: (ahead: number, behind: number) => void;
  // Theme actions
  setLightTheme: (theme: ThemeMode) => void;
  setDarkTheme: (theme: ThemeMode) => void;
  setThemeCategory: (category: ThemeCategory) => void;
  setSystemPrefersDark: (value: boolean) => void;
  setLanguage: (lang: Language) => void;
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
  // Quick Commands actions
  setTerminalQuickCommands: (commands: TerminalQuickCommand[]) => void;
  removeTerminalQuickCommand: (id: string) => void;
  // Agent actions
  setDefaultAgentId: (agentId: AiAgentId | null) => void;
  setGitCommitMessageProfiles: (
    profiles: GitCommitMessageProfile[],
    defaultProfileId: string,
  ) => void;
  // Security actions
  setAgentPermissionDefaults: (agentId: AiAgentId, launchOptions?: SessionLaunchOptions) => void;
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
  markAttentionSeen: (id: string) => void;
  resolveAttention: (id: string, reason: string) => void;
  dismissAttention: (id: string) => void;
  resolveAttentionForSession: (sessionId: string, reason: string) => void;
  setAgentHookDiagnostic: (diagnostic: AgentHookDiagnostic) => void;
  recordAttentionEventDiagnostic: (diagnostic: AttentionEventDiagnostic) => void;
  recordNotificationDelivery: (diagnostic: NotificationDeliveryDiagnostic) => void;
  upsertGitCloneTask: (task: GitCloneTask) => void;
  removeGitCloneTask: (taskId: string) => void;
  activeTheme: () => ThemeMode;
  // Voice Recognition (ASR) actions
  setAsrApiKey: (apiKey: string) => void;
  setAsrAuthMode: (authMode: MimoAuthMode) => void;
  setAsrModel: (model: string) => void;
  setAsrRegion: (region: DashScopeRegion) => void;
  setVoiceShortcut: (keys: string) => void;
  setVoiceInputTarget: (target: VoiceInputTarget) => void;
  setVoiceTriggerVisible: (visible: boolean) => void;
}

// 底部脚本运行器使用独立 store，不扩充主 AppState。
export type BottomRunnerTabStatus = "starting" | "running" | "success" | "error" | "stopped" | "completed";
export interface BottomRunnerTab {
  id: string;
  sessionId: string;
  commandId: string;
  commandLabel: string;
  commandText: string;
  projectPath: string;
  shell: TerminalShell;
  status: BottomRunnerTabStatus;
  exitCode: number | null;
  startTime: number;
  endTime: number | null;
}
export interface BottomRunnerState {
  open: boolean;
  height: number;
  maximized: boolean;
  autoScroll: boolean;
  wordWrap: boolean;
  tabsByProject: Record<string, BottomRunnerTab[]>;
  activeTabIdByProject: Record<string, string | null>;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setHeight: (height: number, viewportHeight?: number) => void;
  setMaximized: (maximized: boolean) => void;
  toggleMaximized: () => void;
  setAutoScroll: (autoScroll: boolean) => void;
  toggleAutoScroll: () => void;
  setWordWrap: (wordWrap: boolean) => void;
  toggleWordWrap: () => void;
  activateTab: (projectPath: string, tabId: string) => void;
  addRunTab: (projectPath: string, tab: BottomRunnerTab) => BottomRunnerTab | null;
  updateTabStatus: (projectPath: string, tabId: string, status: BottomRunnerTabStatus, exitCode?: number | null) => void;
  closeTab: (projectPath: string, tabId: string) => void;
  clearFinishedTabs: (projectPath: string) => void;
  handleProjectChange: (projectPath: string) => void;
  reset: () => void;
}
