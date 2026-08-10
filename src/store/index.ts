import { create, type StateCreator } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type {
  AiAgentId,
  ClaudeCliInfo,
  AgentPermissionDefaults,
  SessionLaunchOptions,
  GitCloneTask,
  PersistentSettings,
  Session,
  TerminalQuickCommand,
  WindowMode,
  WindowProjectContext,
} from "@/types";
import { normalizeQuickCommands } from "@/lib/quickCommands";
import { getPermissionDefaultsForLaunch, isAiAgentId } from "@/lib/agents";
import {
  markAttentionForSessionViewed,
  mergeAttentionProjection,
  projectAttentionItems,
  transitionAttentionItems,
  type AttentionItem,
  type AttentionDisposition,
} from "@/lib/attention";
import type {
  AgentHookDiagnostic,
  AttentionDiagnostics,
  AttentionEventDiagnostic,
  NotificationDeliveryDiagnostic,
} from "@/lib/attentionDiagnostics";
import {
  sanitizePersistedAttentionItems,
  sanitizePersistedSessionEvents,
} from "@/lib/attentionPersistence";
import {
  isEphemeralTerminalSession,
  withoutSessionHistoryExcludedSessions,
} from "@/lib/sessions";
import { normalizeArchivedSessionGroups } from "@/lib/archivedSessions";
import {
  DEFAULT_MIMO_AUTH_MODE,
  normalizeMimoAuthMode,
  type MimoAuthMode,
} from "@/lib/mimoAsr";
import i18n from "@/i18n";
import {
  migrateRecentProjectState,
  rehydrateRecentProjectState,
  touchRecentProjects,
  type ProjectInfo,
  type RecentProjectEntry,
} from "./utils/recentProjects";

export type ThemeMode = "light-glass" | "light-warm" | "dark-starry" | "dark-mocha";
export type ThemeCategory = "light" | "dark" | "system";
export type Language = "zh_CN" | "zh_TW" | "en" | "ja";
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
export type FeishuNotificationEvent = "completed" | "error" | "waiting" | "permission";
export type FeishuNotificationEventMap = Record<FeishuNotificationEvent, boolean>;
export type SessionRuntimeStatus = "starting" | "running" | "waiting" | "completed" | "error" | "stopped";
export type VoiceInputTarget = "terminal" | "system";
export type DashScopeRegion = "beijing" | "singapore" | "us";
export type TerminalShell = "powershell" | "cmd";
export type TerminalRenderer = "webgl" | "standard";
export const DEFAULT_ASR_MODEL = "mimo-v2.5-asr";
export const DEFAULT_DASHSCOPE_REGION: DashScopeRegion = "beijing";
export const DEFAULT_VOICE_SHORTCUT = "Ctrl+Shift+V";
export const DEFAULT_VOICE_INPUT_TARGET: VoiceInputTarget = "system";
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

function createMemoryStateStorage(): StateStorage {
  const data = new Map<string, string>();
  return {
    getItem: (name) => data.get(name) ?? null,
    setItem: (name, value) => {
      data.set(name, value);
    },
    removeItem: (name) => {
      data.delete(name);
    },
  };
}

function getDefaultStateStorage(): StateStorage {
  if (typeof localStorage !== "undefined") {
    return localStorage;
  }
  return createMemoryStateStorage();
}

const LEGACY_ASR_MODEL_ALIASES = new Map<string, string>([
  ["mimo-v2.5-pro", DEFAULT_ASR_MODEL],
  ["mimo-v2.5-asr", DEFAULT_ASR_MODEL],
]);

export function normalizeAsrModel(model: string | null | undefined): string {
  const trimmed = model?.trim();
  if (!trimmed) {
    return DEFAULT_ASR_MODEL;
  }

  const mapped = LEGACY_ASR_MODEL_ALIASES.get(trimmed.toLowerCase());
  return mapped ?? trimmed;
}

export function normalizeDashScopeRegion(
  region: string | null | undefined
): DashScopeRegion {
  return region === "singapore" || region === "us"
    ? region
    : DEFAULT_DASHSCOPE_REGION;
}

export function normalizeVoiceInputTarget(
  target: string | null | undefined
): VoiceInputTarget {
  return target === "system" ? "system" : DEFAULT_VOICE_INPUT_TARGET;
}

function normalizeThemeModeValue(mode: string | null | undefined): ThemeMode {
  return mode === "light-warm" ||
    mode === "dark-starry" ||
    mode === "dark-mocha"
    ? mode
    : "light-glass";
}

function normalizeDarkThemeModeValue(mode: string | null | undefined): ThemeMode {
  return mode === "dark-mocha" || mode === "dark-starry" ? mode : "dark-starry";
}

function normalizeThemeCategoryValue(category: string | null | undefined): ThemeCategory {
  return category === "light" || category === "system" ? category : "dark";
}

function normalizeLanguageValue(language: string | null | undefined): Language {
  const normalizedLanguage = language?.trim();
  if (normalizedLanguage === "en") {
    return "en";
  }
  if (normalizedLanguage === "zh_TW" || normalizedLanguage === "zh-TW") {
    return "zh_TW";
  }
  if (normalizedLanguage === "ja" || normalizedLanguage === "ja-JP") {
    return "ja";
  }
  if (normalizedLanguage === "zh_CN" || normalizedLanguage === "zh-CN") {
    return "zh_CN";
  }
  return "zh_CN";
}

export function normalizeTerminalRendererValue(
  renderer: string | null | undefined
): TerminalRenderer {
  // The former "auto" setting enabled WebGL whenever WebGL2 was available.
  // Some Windows GPU drivers only fail while rendering scrollback, which cannot
  // be detected from the capability probe. Migrate it to the stable renderer.
  return renderer === "webgl" ? "webgl" : "standard";
}

function normalizeStartupRestoreLastProjectValue(
  value: boolean | null | undefined
): boolean {
  return value ?? true;
}

function normalizeLastProjectPathValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function projectInfoFromPath(path: string): ProjectInfo {
  return {
    path,
    name: path.split(/[\\/]/).filter(Boolean).pop() || path,
  };
}

function normalizeNotificationSoundValue(value: string | null | undefined): NotificationSoundType {
  return value === "waiting" ||
    value === "alert" ||
    value === "chime" ||
    value === "bell" ||
    value === "glass" ||
    value === "bloom" ||
    value === "pebble" ||
    value === "pulse" ||
    value === "signal" ||
    value === "slate" ||
    value === "aurora" ||
    value === "hush"
    ? value
    : "default";
}

export function getPersistentSettingsSnapshot(): PersistentSettings {
  const state = useAppStore.getState();
  return {
    lightTheme: state.lightTheme,
    darkTheme: state.darkTheme,
    themeCategory: state.themeCategory,
    language: state.language,
    startupRestoreLastProject: state.startupRestoreLastProject,
    lastProjectPath: state.lastProject?.path ?? null,
    editorFontSize: state.editorFontSize,
    terminalFontSize: state.terminalFontSize,
    terminalCursorBlink: state.terminalCursorBlink,
    terminalLineHeight: state.terminalLineHeight,
    terminalRenderer: state.terminalRenderer,
    terminalQuickCommands: state.terminalQuickCommands,
    defaultAgentId: state.defaultAgentId,
    agentPermissionDefaults: state.agentPermissionDefaults,
    notificationEnabled: state.notificationEnabled,
    notificationSoundEnabled: state.notificationSoundEnabled,
    notificationSoundMap: state.notificationSoundMap,
    notificationThresholdMs: state.notificationThresholdMs,
    feishuNotificationEnabled: state.feishuNotificationEnabled,
    feishuNotificationThresholdMs: state.feishuNotificationThresholdMs,
    feishuNotificationEvents: state.feishuNotificationEvents,
    asrApiKey: state.asrApiKey,
    asrAuthMode: state.asrAuthMode,
    asrModel: state.asrModel,
    asrRegion: state.asrRegion,
    voiceShortcut: state.voiceShortcut,
    voiceInputTarget: state.voiceInputTarget,
    voiceTriggerVisible: state.voiceTriggerVisible,
  };
}

export function applyPersistentSettingsToStore(settings: PersistentSettings) {
  const lastProjectPath = normalizeLastProjectPathValue(settings.lastProjectPath);
  useAppStore.setState({
    lightTheme: normalizeThemeModeValue(settings.lightTheme),
    darkTheme: normalizeDarkThemeModeValue(settings.darkTheme),
    themeCategory: normalizeThemeCategoryValue(settings.themeCategory),
    language: normalizeLanguageValue(settings.language),
    startupRestoreLastProject: normalizeStartupRestoreLastProjectValue(
      settings.startupRestoreLastProject
    ),
    lastProject: lastProjectPath ? projectInfoFromPath(lastProjectPath) : null,
    editorFontSize: Math.max(10, Math.round(settings.editorFontSize || 14)),
    terminalFontSize: Math.max(10, Math.round(settings.terminalFontSize || 14)),
    terminalCursorBlink: settings.terminalCursorBlink ?? false,
    terminalLineHeight: settings.terminalLineHeight || 1.2,
    terminalRenderer: normalizeTerminalRendererValue(settings.terminalRenderer),
    terminalQuickCommands: normalizeQuickCommands(settings.terminalQuickCommands),
    defaultAgentId: normalizeDefaultAgentId(settings.defaultAgentId),
    agentPermissionDefaults: normalizeAgentPermissionDefaults(settings.agentPermissionDefaults),
    notificationEnabled: settings.notificationEnabled ?? true,
    notificationSoundEnabled: settings.notificationSoundEnabled ?? true,
    notificationSoundMap: {
      taskComplete: normalizeNotificationSoundValue(settings.notificationSoundMap?.taskComplete),
      error: normalizeNotificationSoundValue(settings.notificationSoundMap?.error),
      waiting: normalizeNotificationSoundValue(settings.notificationSoundMap?.waiting),
    },
    notificationThresholdMs: Math.max(0, Math.round(settings.notificationThresholdMs ?? 10000)),
    feishuNotificationEnabled: settings.feishuNotificationEnabled ?? false,
    feishuNotificationThresholdMs: Math.max(
      0,
      Math.round(settings.feishuNotificationThresholdMs ?? 300000)
    ),
    feishuNotificationEvents: {
      completed: settings.feishuNotificationEvents?.completed ?? true,
      error: settings.feishuNotificationEvents?.error ?? true,
      waiting: settings.feishuNotificationEvents?.waiting ?? true,
      permission: settings.feishuNotificationEvents?.permission ?? true,
    },
    asrApiKey: settings.asrApiKey ?? "",
    asrAuthMode: normalizeMimoAuthMode(settings.asrAuthMode, settings.asrApiKey),
    asrModel: normalizeAsrModel(settings.asrModel),
    asrRegion: normalizeDashScopeRegion(settings.asrRegion),
    voiceShortcut: settings.voiceShortcut ?? DEFAULT_VOICE_SHORTCUT,
    voiceInputTarget: normalizeVoiceInputTarget(settings.voiceInputTarget),
    voiceTriggerVisible: settings.voiceTriggerVisible ?? true,
  });
}

function normalizeAgentPermissionDefaults(value: unknown): AgentPermissionDefaults {
  const source = asSettingsRecord(value);
  if (!source) return {};

  const defaults: AgentPermissionDefaults = {};
  const claude = asSettingsRecord(source.claude);
  if (typeof claude?.skipPermissions === "boolean") {
    defaults.claude = { skipPermissions: claude.skipPermissions };
  }

  const codex = asSettingsRecord(source.codex);
  if (
    typeof codex?.yolo === "boolean" &&
    (codex.approvalMode === "untrusted" ||
      codex.approvalMode === "on-request" ||
      codex.approvalMode === "never") &&
    (codex.sandboxMode === "workspace-write" || codex.sandboxMode === "read-only")
  ) {
    defaults.codex = {
      yolo: codex.yolo,
      approvalMode: codex.approvalMode,
      sandboxMode: codex.sandboxMode,
    };
  }

  const antigravity = asSettingsRecord(source.antigravity);
  if (
    typeof antigravity?.dangerouslySkipPermissions === "boolean" &&
    typeof antigravity.sandbox === "boolean" &&
    (antigravity.mode === "inherit" ||
      antigravity.mode === "accept-edits" ||
      antigravity.mode === "plan")
  ) {
    defaults.antigravity = {
      dangerouslySkipPermissions: antigravity.dangerouslySkipPermissions,
      sandbox: antigravity.sandbox,
      mode: antigravity.mode,
    };
  }

  const qoder = asSettingsRecord(source.qoder);
  if (
    qoder?.permissionMode === "inherit" ||
    qoder?.permissionMode === "default" ||
    qoder?.permissionMode === "accept_edits" ||
    qoder?.permissionMode === "plan" ||
    qoder?.permissionMode === "bypass_permissions" ||
    qoder?.permissionMode === "dont_ask" ||
    qoder?.permissionMode === "auto"
  ) {
    defaults.qoder = { permissionMode: qoder.permissionMode };
  }

  return defaults;
}

function asSettingsRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeDefaultAgentId(value: unknown): AiAgentId | null {
  return isAiAgentId(value)
    ? value
    : value === "gemini"
      ? "antigravity"
    : null;
}

export type TabKind = "session" | "settings" | "diff" | "preview" | "file";
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
  hunkActionsAvailable?: boolean;
  originalContent: string;
  modifiedContent: string;
  originalLabel: string;
  modifiedLabel: string;
  isBinary: boolean;
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

interface ProjectWorkspace {
  tabsById: Record<string, TabEntity>;
  panesById: Record<string, PaneState>;
  layout: WorkspaceLayout;
  activePaneId: string | null;
  focusedTabId: string | null;
}

interface AppState {
  windowContextReady: boolean;
  windowMode: WindowMode;
  windowLabel: string;
  windowProject: ProjectInfo | null;
  lastProject: ProjectInfo | null;
  startupRestoreLastProject: boolean;
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
  terminalRenderer: TerminalRenderer;
  defaultTerminalShell: TerminalShell;
  // Quick Commands
  terminalQuickCommands: TerminalQuickCommand[];
  // Agents
  defaultAgentId: AiAgentId | null;
  // Security
  agentPermissionDefaults: AgentPermissionDefaults;
  // Notification
  notificationEnabled: boolean;
  notificationSoundEnabled: boolean;
  notificationSoundMap: NotificationSoundMap;
  notificationThresholdMs: number;
  feishuNotificationEnabled: boolean;
  feishuNotificationThresholdMs: number;
  feishuNotificationEvents: FeishuNotificationEventMap;
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
  openGitDiffTab: (document: Omit<GitDiffDocumentState, "tabId">) => string | null;
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
  // Terminal actions
  setEditorFontSize: (size: number) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalCursorBlink: (blink: boolean) => void;
  setTerminalLineHeight: (height: number) => void;
  setTerminalRenderer: (renderer: TerminalRenderer) => void;
  setDefaultTerminalShell: (shell: TerminalShell) => void;
  // Quick Commands actions
  setTerminalQuickCommands: (commands: TerminalQuickCommand[]) => void;
  removeTerminalQuickCommand: (id: string) => void;
  // Agent actions
  setDefaultAgentId: (agentId: AiAgentId | null) => void;
  // Security actions
  setAgentPermissionDefaults: (agentId: AiAgentId, launchOptions?: SessionLaunchOptions) => void;
  // Notification actions
  setNotificationEnabled: (enabled: boolean) => void;
  setNotificationSoundEnabled: (enabled: boolean) => void;
  setNotificationSoundMap: (event: NotificationEvent, sound: NotificationSoundType) => void;
  setNotificationThreshold: (thresholdMs: number) => void;
  setFeishuNotificationEnabled: (enabled: boolean) => void;
  setFeishuNotificationThreshold: (thresholdMs: number) => void;
  setFeishuNotificationEvent: (event: FeishuNotificationEvent, enabled: boolean) => void;
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

const MAIN_PANE_ID = "main";
const SETTINGS_ID = "__settings__";
const LAUNCHER_WORKSPACE_KEY = "__launcher__";
const DEFAULT_SIDEBAR_WIDTH = 248;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 360;
const DEFAULT_LAYOUT: WorkspaceLayout = {
  root: { type: "pane", paneId: MAIN_PANE_ID },
};

function clampSidebarWidth(width: number | null | undefined) {
  return Math.min(
    MAX_SIDEBAR_WIDTH,
    Math.max(MIN_SIDEBAR_WIDTH, Math.round(width || DEFAULT_SIDEBAR_WIDTH))
  );
}

function sortRecentProjects(projects: RecentProjectEntry[]) {
  return [...projects]
    .filter((item) => item.path.trim().length > 0)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, 10);
}

function createDefaultWorkspace(): ProjectWorkspace {
  return {
    tabsById: {},
    panesById: {
      [MAIN_PANE_ID]: {
        id: MAIN_PANE_ID,
        tabIds: [],
        activeTabId: null,
        history: [],
      },
    },
    layout: DEFAULT_LAYOUT,
    activePaneId: MAIN_PANE_ID,
    focusedTabId: null,
  };
}

function cloneWorkspace(workspace: ProjectWorkspace): ProjectWorkspace {
  return {
    tabsById: { ...workspace.tabsById },
    panesById: Object.fromEntries(
      Object.entries(workspace.panesById).map(([paneId, pane]) => [
        paneId,
        {
          ...pane,
          tabIds: [...pane.tabIds],
          history: [...pane.history],
        },
      ])
    ),
    layout: workspace.layout,
    activePaneId: workspace.activePaneId,
    focusedTabId: workspace.focusedTabId,
  };
}

function createSettingsTab(now = Date.now()): TabEntity {
  return {
    id: SETTINGS_ID,
    kind: "settings",
    resourceId: SETTINGS_ID,
    title: i18n.t("common.settings"),
    closable: true,
    pinned: false,
    dirty: false,
    preview: false,
    createdAt: now,
    lastActivatedAt: now,
  };
}

function createSessionTab(session: Session, now = Date.now()): TabEntity {
  return {
    id: session.id,
    kind: "session",
    resourceId: session.id,
    title: session.name,
    closable: true,
    pinned: false,
    dirty: false,
    preview: false,
    createdAt: session.createdAt ?? now,
    lastActivatedAt: now,
  };
}

function normalizeFilePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function getFileTabId(path: string): string {
  return `file:${normalizeFilePath(path)}`;
}

function getGitDiffTabId(
  path: string,
  staged: boolean,
  revision?: string | null,
): string {
  if (revision) {
    return `git-diff:commit:${revision}:${normalizeFilePath(path)}`;
  }
  return `git-diff:${staged ? "staged" : "worktree"}:${normalizeFilePath(path)}`;
}

function getGitDiffTitle(
  path: string,
  staged: boolean,
  revision?: string | null,
  revisionLabel?: string,
): string {
  const contextLabel = revision
    ? revisionLabel ?? revision.slice(0, 7)
    : staged
      ? "\u7d22\u5f15"
      : "\u5de5\u4f5c\u6811";
  return `${getFileName(path)} (${contextLabel})`;
}
function getFileName(path: string): string {
  const normalizedPath = path.replace(/[\\/]+$/, "");
  const segments = normalizedPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function inferFileDocumentKind(path: string): FileDocumentKind {
  const extension = getFileName(path).split(".").pop()?.toLowerCase() ?? "";
  if (extension === "pdf") {
    return "pdf";
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(extension)) {
    return "image";
  }
  if (
    [
      "txt",
      "md",
      "json",
      "js",
      "jsx",
      "ts",
      "tsx",
      "rs",
      "css",
      "scss",
      "html",
      "htm",
      "xml",
      "yml",
      "yaml",
      "toml",
      "sh",
      "ps1",
      "bat",
      "env",
      "log",
      "csv",
      "sql",
      "py",
      "java",
      "go",
      "c",
      "cpp",
      "h",
      "hpp",
    ].includes(extension)
  ) {
    return "text";
  }
  return "binary";
}

function createFileTab(path: string, now = Date.now()): TabEntity {
  return {
    id: getFileTabId(path),
    kind: "file",
    resourceId: path,
    title: getFileName(path),
    closable: true,
    pinned: false,
    dirty: false,
    preview: false,
    createdAt: now,
    lastActivatedAt: now,
  };
}

function createGitDiffTab(
  path: string,
  staged: boolean,
  now = Date.now(),
  revision?: string | null,
  revisionLabel?: string,
): TabEntity {
  return {
    id: getGitDiffTabId(path, staged, revision),
    kind: "diff",
    resourceId: path,
    title: getGitDiffTitle(path, staged, revision, revisionLabel),
    closable: true,
    pinned: false,
    dirty: false,
    preview: false,
    createdAt: now,
    lastActivatedAt: now,
  };
}
function getActivePane(workspace: ProjectWorkspace, paneId?: string): PaneState {
  const resolvedPaneId = paneId ?? workspace.activePaneId ?? MAIN_PANE_ID;
  return workspace.panesById[resolvedPaneId] ?? workspace.panesById[MAIN_PANE_ID];
}

function touchPaneHistory(pane: PaneState, tabId: string) {
  pane.history = [...pane.history.filter((id) => id !== tabId), tabId];
}

function findFallbackActiveTabId(pane: PaneState): string | null {
  const historyCandidate = [...pane.history].reverse().find((tabId) => pane.tabIds.includes(tabId));
  if (historyCandidate) return historyCandidate;
  return pane.tabIds[pane.tabIds.length - 1] ?? null;
}

function pruneEmptyLayoutNode(
  node: LayoutNode,
  nonEmptyPaneIds: Set<string>
): LayoutNode | null {
  if (node.type === "pane") {
    return nonEmptyPaneIds.has(node.paneId) ? node : null;
  }
  const first = pruneEmptyLayoutNode(node.first, nonEmptyPaneIds);
  const second = pruneEmptyLayoutNode(node.second, nonEmptyPaneIds);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function compactEmptyPanes(workspace: ProjectWorkspace) {
  const nonEmptyPaneIds = new Set(
    Object.values(workspace.panesById)
      .filter((pane) => pane.tabIds.length > 0)
      .map((pane) => pane.id)
  );

  if (nonEmptyPaneIds.size === 0) {
    workspace.panesById = createDefaultWorkspace().panesById;
    workspace.layout = DEFAULT_LAYOUT;
    workspace.activePaneId = MAIN_PANE_ID;
    workspace.focusedTabId = null;
    return;
  }

  for (const paneId of Object.keys(workspace.panesById)) {
    if (!nonEmptyPaneIds.has(paneId)) delete workspace.panesById[paneId];
  }
  const fallbackPaneId = nonEmptyPaneIds.values().next().value as string;
  workspace.layout = {
    root: pruneEmptyLayoutNode(workspace.layout.root, nonEmptyPaneIds) ?? {
      type: "pane",
      paneId: fallbackPaneId,
    },
  };
  if (!workspace.activePaneId || !nonEmptyPaneIds.has(workspace.activePaneId)) {
    workspace.activePaneId = fallbackPaneId;
    workspace.focusedTabId = workspace.panesById[fallbackPaneId].activeTabId;
  }
}

function normalizeWorkspace(workspace: ProjectWorkspace, sessions: Session[]): ProjectWorkspace {
  const nextWorkspace = cloneWorkspace(workspace);
  const sessionById = new Map(sessions.map((session) => [session.id, session]));

  if (!nextWorkspace.panesById[MAIN_PANE_ID]) {
    nextWorkspace.panesById[MAIN_PANE_ID] = {
      id: MAIN_PANE_ID,
      tabIds: [],
      activeTabId: null,
      history: [],
    };
  }

  for (const tab of Object.values(nextWorkspace.tabsById)) {
    if (tab.kind === "session") {
      const session = sessionById.get(tab.resourceId);
      if (!session) continue;
      tab.title = session.name;
    } else if (tab.kind === "file") {
      tab.title = getFileName(tab.resourceId);
    } else if (tab.kind === "diff") {
      const staged = tab.id.includes("git-diff:staged:");
      tab.title = `${getFileName(tab.resourceId)} (${staged ? "索引" : "工作树"})`;
    }
  }

  for (const pane of Object.values(nextWorkspace.panesById)) {
    pane.tabIds = pane.tabIds.filter((tabId) => {
      if (tabId === SETTINGS_ID) {
        if (!nextWorkspace.tabsById[tabId]) {
          nextWorkspace.tabsById[tabId] = createSettingsTab();
        }
        return true;
      }
      const existingTab = nextWorkspace.tabsById[tabId];
      if (existingTab?.kind === "file" || existingTab?.kind === "diff") {
        existingTab.title = getFileName(existingTab.resourceId);
        if (existingTab.kind === "diff") {
          const staged = existingTab.id.includes("git-diff:staged:");
          existingTab.title = `${getFileName(existingTab.resourceId)} (${staged ? "索引" : "工作树"})`;
        }
        return true;
      }
      const session = sessionById.get(tabId);
      if (!session) return false;
      nextWorkspace.tabsById[tabId] =
        nextWorkspace.tabsById[tabId] ?? createSessionTab(session);
      nextWorkspace.tabsById[tabId].title = session.name;
      return true;
    });
    pane.history = pane.history.filter((tabId) => pane.tabIds.includes(tabId));
    if (pane.activeTabId && !pane.tabIds.includes(pane.activeTabId)) {
      pane.activeTabId = findFallbackActiveTabId(pane);
    }
  }

  const referencedTabIds = new Set(
    Object.values(nextWorkspace.panesById).flatMap((pane) => pane.tabIds)
  );
  for (const tabId of Object.keys(nextWorkspace.tabsById)) {
    if (!referencedTabIds.has(tabId)) {
      delete nextWorkspace.tabsById[tabId];
    }
  }

  compactEmptyPanes(nextWorkspace);

  if (!nextWorkspace.activePaneId || !nextWorkspace.panesById[nextWorkspace.activePaneId]) {
    nextWorkspace.activePaneId = MAIN_PANE_ID;
  }

  if (
    nextWorkspace.focusedTabId &&
    !nextWorkspace.tabsById[nextWorkspace.focusedTabId]
  ) {
    nextWorkspace.focusedTabId = getActivePane(nextWorkspace).activeTabId;
  }

  return nextWorkspace;
}

function syncWorkspaceSnapshot(workspace: ProjectWorkspace) {
  const activePane = getActivePane(workspace);
  return {
    tabsById: workspace.tabsById,
    panesById: workspace.panesById,
    layout: workspace.layout,
    activePaneId: workspace.activePaneId,
    focusedTabId: workspace.focusedTabId,
    openTabs: [...activePane.tabIds],
    activeSessionId: activePane.activeTabId,
  };
}

function syncProjectState(
  state: AppState,
  path: string,
  sessions: Session[],
  workspace: ProjectWorkspace
) {
  const normalizedWorkspace = normalizeWorkspace(workspace, sessions);
  return {
    projectSessions: { ...state.projectSessions, [path]: sessions },
    projectWorkspaces: {
      ...state.projectWorkspaces,
      [path]: normalizedWorkspace,
    },
    sessions,
    ...syncWorkspaceSnapshot(normalizedWorkspace),
  };
}

function ensureTabForId(
  workspace: ProjectWorkspace,
  tabId: string,
  sessions: Session[]
): TabEntity | null {
  if (workspace.tabsById[tabId]) return workspace.tabsById[tabId];
  if (tabId === SETTINGS_ID) {
    const tab = createSettingsTab();
    workspace.tabsById[tab.id] = tab;
    return tab;
  }
  const session = sessions.find((item) => item.id === tabId);
  if (!session) return null;
  const tab = createSessionTab(session);
  workspace.tabsById[tab.id] = tab;
  return tab;
}

function openTabInWorkspace(
  workspace: ProjectWorkspace,
  tabId: string,
  sessions: Session[],
  paneId?: string
) {
  const nextWorkspace = cloneWorkspace(workspace);
  const pane = getActivePane(nextWorkspace, paneId);
  const tab = ensureTabForId(nextWorkspace, tabId, sessions);
  if (!tab) return nextWorkspace;
  if (!pane.tabIds.includes(tabId)) {
    pane.tabIds.push(tabId);
  }
  const now = Date.now();
  nextWorkspace.tabsById[tabId] = {
    ...tab,
    lastActivatedAt: now,
  };
  pane.activeTabId = tabId;
  touchPaneHistory(pane, tabId);
  nextWorkspace.activePaneId = pane.id;
  nextWorkspace.focusedTabId = tabId;
  return nextWorkspace;
}

function activateTabInWorkspace(
  workspace: ProjectWorkspace,
  tabId: string | null,
  paneId?: string
) {
  const nextWorkspace = cloneWorkspace(workspace);
  const pane = getActivePane(nextWorkspace, paneId);
  if (!tabId) {
    pane.activeTabId = null;
    nextWorkspace.focusedTabId = null;
    nextWorkspace.activePaneId = pane.id;
    return nextWorkspace;
  }
  if (!pane.tabIds.includes(tabId)) return nextWorkspace;
  pane.activeTabId = tabId;
  touchPaneHistory(pane, tabId);
  if (nextWorkspace.tabsById[tabId]) {
    nextWorkspace.tabsById[tabId] = {
      ...nextWorkspace.tabsById[tabId],
      lastActivatedAt: Date.now(),
    };
  }
  nextWorkspace.activePaneId = pane.id;
  nextWorkspace.focusedTabId = tabId;
  return nextWorkspace;
}

function closeTabInWorkspace(workspace: ProjectWorkspace, tabId: string, paneId?: string) {
  const nextWorkspace = cloneWorkspace(workspace);
  for (const pane of Object.values(nextWorkspace.panesById)) {
    if (paneId && pane.id !== paneId) continue;
    if (!pane.tabIds.includes(tabId)) continue;
    pane.tabIds = pane.tabIds.filter((id) => id !== tabId);
    pane.history = pane.history.filter((id) => id !== tabId);
    if (pane.activeTabId === tabId) {
      pane.activeTabId = findFallbackActiveTabId(pane);
    }
  }
  const stillReferenced = Object.values(nextWorkspace.panesById)
    .some((pane) => pane.tabIds.includes(tabId));
  if (!stillReferenced) delete nextWorkspace.tabsById[tabId];
  if (nextWorkspace.focusedTabId === tabId) {
    nextWorkspace.focusedTabId = getActivePane(nextWorkspace).activeTabId;
  }
  compactEmptyPanes(nextWorkspace);
  return nextWorkspace;
}

function reorderTabsInWorkspace(
  workspace: ProjectWorkspace,
  sourceTabId: string,
  targetTabId: string,
  position: TabDropPosition,
  paneId?: string
) {
  if (sourceTabId === targetTabId) return workspace;
  const nextWorkspace = cloneWorkspace(workspace);
  const pane = getActivePane(nextWorkspace, paneId);
  const sourceIndex = pane.tabIds.indexOf(sourceTabId);
  const targetIndex = pane.tabIds.indexOf(targetTabId);
  if (sourceIndex < 0 || targetIndex < 0) return workspace;

  const nextTabIds = [...pane.tabIds];
  nextTabIds.splice(sourceIndex, 1);
  let insertIndex = targetIndex;
  if (sourceIndex < targetIndex) {
    insertIndex -= 1;
  }
  if (position === "after") {
    insertIndex += 1;
  }
  nextTabIds.splice(Math.max(0, insertIndex), 0, sourceTabId);
  pane.tabIds = nextTabIds;
  return nextWorkspace;
}

function moveTabToPaneInWorkspace(
  workspace: ProjectWorkspace,
  tabId: string,
  sourcePaneId: string,
  targetPaneId: string,
  targetTabId?: string | null,
  position: TabDropPosition = "after"
) {
  if (sourcePaneId === targetPaneId) return workspace;
  const sourcePane = workspace.panesById[sourcePaneId];
  const targetPane = workspace.panesById[targetPaneId];
  if (!sourcePane?.tabIds.includes(tabId) || !targetPane) return workspace;

  const nextWorkspace = cloneWorkspace(workspace);
  const nextSourcePane = nextWorkspace.panesById[sourcePaneId];
  const nextTargetPane = nextWorkspace.panesById[targetPaneId];
  nextSourcePane.tabIds = nextSourcePane.tabIds.filter((id) => id !== tabId);
  nextSourcePane.history = nextSourcePane.history.filter((id) => id !== tabId);
  if (nextSourcePane.activeTabId === tabId) {
    nextSourcePane.activeTabId = findFallbackActiveTabId(nextSourcePane);
  }
  if (!nextTargetPane.tabIds.includes(tabId)) {
    const nextTabIds = [...nextTargetPane.tabIds];
    const targetIndex = targetTabId ? nextTabIds.indexOf(targetTabId) : -1;
    const insertIndex = targetIndex < 0
      ? nextTabIds.length
      : targetIndex + (position === "after" ? 1 : 0);
    nextTabIds.splice(insertIndex, 0, tabId);
    nextTargetPane.tabIds = nextTabIds;
  }
  nextTargetPane.activeTabId = tabId;
  touchPaneHistory(nextTargetPane, tabId);
  nextWorkspace.activePaneId = targetPaneId;
  nextWorkspace.focusedTabId = tabId;
  compactEmptyPanes(nextWorkspace);
  return nextWorkspace;
}

function replacePaneWithSplit(
  node: LayoutNode,
  targetPaneId: string,
  newPaneId: string,
  direction: SplitDirection
): LayoutNode {
  if (node.type === "pane") {
    if (node.paneId !== targetPaneId) return node;
    const currentPane: LayoutNode = { type: "pane", paneId: targetPaneId };
    const newPane: LayoutNode = { type: "pane", paneId: newPaneId };
    const newPaneFirst = direction === "left" || direction === "up";
    return {
      type: "split",
      direction: direction === "left" || direction === "right" ? "horizontal" : "vertical",
      ratio: 0.5,
      first: newPaneFirst ? newPane : currentPane,
      second: newPaneFirst ? currentPane : newPane,
    };
  }

  return {
    ...node,
    first: replacePaneWithSplit(node.first, targetPaneId, newPaneId, direction),
    second: replacePaneWithSplit(node.second, targetPaneId, newPaneId, direction),
  };
}

function splitTabInWorkspace(
  workspace: ProjectWorkspace,
  tabId: string,
  direction: SplitDirection,
  paneId?: string,
  mode: SplitMode = "move"
) {
  const nextWorkspace = cloneWorkspace(workspace);
  const sourcePane = getActivePane(nextWorkspace, paneId);
  if (!sourcePane.tabIds.includes(tabId) || (mode === "move" && sourcePane.tabIds.length <= 1)) {
    return workspace;
  }

  const newPaneId = `pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (mode === "move") {
    sourcePane.tabIds = sourcePane.tabIds.filter((id) => id !== tabId);
    sourcePane.history = sourcePane.history.filter((id) => id !== tabId);
    if (sourcePane.activeTabId === tabId) {
      sourcePane.activeTabId = findFallbackActiveTabId(sourcePane);
    }
  }

  nextWorkspace.panesById[newPaneId] = {
    id: newPaneId,
    tabIds: [tabId],
    activeTabId: tabId,
    history: [tabId],
  };
  nextWorkspace.layout = {
    root: replacePaneWithSplit(
      nextWorkspace.layout.root,
      sourcePane.id,
      newPaneId,
      direction
    ),
  };
  nextWorkspace.activePaneId = newPaneId;
  nextWorkspace.focusedTabId = tabId;
  return nextWorkspace;
}

function clampWorkspaceSplitRatio(ratio: number) {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(0.8, Math.max(0.2, ratio));
}

function setLayoutSplitRatioAtPath(
  node: LayoutNode,
  splitPath: number[],
  ratio: number
): LayoutNode {
  if (node.type === "pane") return node;
  if (splitPath.length === 0) {
    return {
      ...node,
      ratio: clampWorkspaceSplitRatio(ratio),
    };
  }

  const [head, ...rest] = splitPath;
  if (head === 0) {
    return {
      ...node,
      first: setLayoutSplitRatioAtPath(node.first, rest, ratio),
    };
  }
  if (head === 1) {
    return {
      ...node,
      second: setLayoutSplitRatioAtPath(node.second, rest, ratio),
    };
  }

  return node;
}

function updateSessionCollection(
  sessions: Session[],
  sessionId: string,
  updates: Partial<Session>
) {
  return sessions.map((session) =>
    session.id === sessionId ? { ...session, ...updates } : session
  );
}

function sameProjectPath(left: string, right: string) {
  return left.replaceAll("/", "\\").toLocaleLowerCase() ===
    right.replaceAll("/", "\\").toLocaleLowerCase();
}

function reconcileProjectAttentionItems(
  current: Record<string, AttentionItem[]>,
  projectPath: string,
  events: readonly SessionStreamEvent[],
  sessions: readonly Session[]
) {
  const projected = projectAttentionItems(
    events.filter((event) => sameProjectPath(event.projectPath, projectPath)),
    sessions
  );
  return {
    ...current,
    [projectPath]: mergeAttentionProjection(projected, current[projectPath] ?? []),
  };
}

function updateAttentionAcrossProjects(
  current: Record<string, AttentionItem[]>,
  update: (items: readonly AttentionItem[]) => AttentionItem[]
) {
  return Object.fromEntries(
    Object.entries(current).map(([projectPath, items]) => [projectPath, update(items)])
  );
}

function transitionAttentionById(
  current: Record<string, AttentionItem[]>,
  id: string,
  disposition: Exclude<AttentionDisposition, "open">,
  reason: string,
  transitionedAt: number
) {
  return updateAttentionAcrossProjects(current, (items) =>
    transitionAttentionItems(
      items,
      (item) => item.id === id,
      disposition,
      reason,
      transitionedAt
    )
  );
}

const createAppState: StateCreator<AppState, [], [], AppState> = (set, get) => {
  return {
      windowContextReady: false,
      currentProject: null,
      windowMode: "launcher",
      windowLabel: "main",
      windowProject: null,
      lastProject: null,
      startupRestoreLastProject: true,
      claudeCliInfo: null,
      recentProjects: [],
      projectSessions: {},
      projectArchivedSessions: {},
      projectWorkspaces: {},
      sessions: [],
      tabsById: {},
      panesById: createDefaultWorkspace().panesById,
      layout: DEFAULT_LAYOUT,
      activePaneId: MAIN_PANE_ID,
      focusedTabId: null,
      dragState: null,
      resourceDragState: null,
      fileDocuments: {},
      gitDiffDocuments: {},
      activeSessionId: null,
      openTabs: [],
      sidebarCollapsed: false,
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      activeSidebarSection: "sessions",
      sidebarPinnedCollapsed: false,
      sidebarSessionsCollapsed: false,
      sidebarGitChangesCollapsed: false,
      sidebarGitGraphCollapsed: true,
      gitChangeCount: 0,
      gitAheadCount: 0,
      gitBehindCount: 0,
      lightTheme: "light-glass",
      darkTheme: "dark-starry",
      themeCategory: "dark",
      systemPrefersDark: false,
      language: "zh_CN",
      editorFontSize: 14,
      terminalFontSize: 14,
      terminalCursorBlink: false,
      terminalLineHeight: 1.2,
      terminalRenderer: "standard",
      defaultTerminalShell: "powershell",
      terminalQuickCommands: [],
      defaultAgentId: null,
      agentPermissionDefaults: {},
      notificationEnabled: true,
      notificationSoundEnabled: true,
      notificationSoundMap: {
        taskComplete: "bloom",
        error: "signal",
        waiting: "pulse",
      },
      notificationThresholdMs: 10000,
      feishuNotificationEnabled: false,
      feishuNotificationThresholdMs: 300000,
      feishuNotificationEvents: {
        completed: true,
        error: true,
        waiting: true,
        permission: true,
      },
      sessionEvents: [],
      projectAttentionItems: {},
      attentionDiagnostics: { hooks: {} },
      unreadTotal: 0,
      gitCloneTasks: [],
      // Voice Recognition (ASR) defaults
      asrApiKey: "",
      asrAuthMode: DEFAULT_MIMO_AUTH_MODE,
      asrModel: DEFAULT_ASR_MODEL,
      asrRegion: DEFAULT_DASHSCOPE_REGION,
      voiceShortcut: DEFAULT_VOICE_SHORTCUT,
      voiceInputTarget: DEFAULT_VOICE_INPUT_TARGET,
      voiceTriggerVisible: true,

      setClaudeCliInfo: (claudeCliInfo) => set({ claudeCliInfo }),
      setDefaultAgentId: (defaultAgentId) => set({ defaultAgentId }),

      setRecentProjects: (projects) =>
        set({
          recentProjects: sortRecentProjects(projects),
        }),

      setLastProject: (lastProject) => set({ lastProject }),

      initializeWindowContext: (context) =>
        set((state) => {
          const windowProject =
            context.mode === "project" && context.projectPath
              ? {
                  path: context.projectPath,
                  name:
                    context.projectName ||
                    context.projectPath.split(/[\\/]/).pop() ||
                    context.projectPath,
                }
              : null;

          if (!windowProject) {
            return {
              windowContextReady: true,
              windowMode: context.mode,
              windowLabel: context.windowLabel,
              activeSidebarSection: "sessions",
              windowProject: null,
              currentProject: null,
              sessions: [],
              tabsById: {},
              panesById: createDefaultWorkspace().panesById,
              layout: DEFAULT_LAYOUT,
              activePaneId: MAIN_PANE_ID,
              focusedTabId: null,
              fileDocuments: {},
              gitDiffDocuments: {},
              openTabs: [],
              activeSessionId: null,
              unreadTotal: 0,
            };
          }

          const sessions = state.projectSessions[windowProject.path] || [];
          const workspace =
            state.projectWorkspaces[windowProject.path] || createDefaultWorkspace();
          const normalizedWorkspace = normalizeWorkspace(workspace, sessions);

          return {
            windowContextReady: true,
            windowMode: context.mode,
            windowLabel: context.windowLabel,
            activeSidebarSection: "sessions",
            windowProject,
            lastProject: windowProject,
            recentProjects: touchRecentProjects(state.recentProjects, windowProject),
            currentProject: windowProject,
            sessions,
            projectWorkspaces: {
              ...state.projectWorkspaces,
              [windowProject.path]: normalizedWorkspace,
            },
            unreadTotal: sessions.reduce(
              (acc, session) => acc + (session.unreadCount ?? 0),
              0
            ),
            ...syncWorkspaceSnapshot(normalizedWorkspace),
          };
        }),

      activeTheme: () => {
        const state = get();
        if (state.themeCategory === "system") {
          return state.systemPrefersDark ? state.darkTheme : state.lightTheme;
        }
        return state.themeCategory === "light" ? state.lightTheme : state.darkTheme;
      },

      setCurrentProject: (project) =>
        set((state) => {
          const sessions = state.projectSessions[project.path] || [];
          const workspace = state.projectWorkspaces[project.path] || createDefaultWorkspace();
          const normalizedWorkspace = normalizeWorkspace(workspace, sessions);
          return {
            currentProject: project,
            activeSidebarSection: "sessions",
            lastProject: project,
            recentProjects: touchRecentProjects(state.recentProjects, project),
            sessions,
            projectWorkspaces: {
              ...state.projectWorkspaces,
              [project.path]: normalizedWorkspace,
            },
            unreadTotal: sessions.reduce((acc, session) => acc + (session.unreadCount ?? 0), 0),
            ...syncWorkspaceSnapshot(normalizedWorkspace),
          };
        }),

      addSession: (session, options) =>
        set((state) => {
          if (!state.currentProject) return state;
          const path = state.currentProject.path;
          const existingSessions = state.projectSessions[path] || [];
          const normalizedSession = {
            ...session,
            titleSource: session.titleSource ?? "default",
            status: session.status ?? "waiting",
            unreadCount: session.unreadCount ?? 0,
            pinned: session.pinned ?? false,
          };
          const sessions = [normalizedSession, ...existingSessions];
          const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
          const nextWorkspace = options?.openInWorkspace === false
            ? currentWorkspace
            : openTabInWorkspace(currentWorkspace, normalizedSession.id, sessions);
          return syncProjectState(state, path, sessions, nextWorkspace);
        }),

      setActiveSession: (id, paneId) =>
        set((state) => {
          if (!state.currentProject) {
            return { activeSessionId: id };
          }
          const path = state.currentProject.path;
          const sessions = id
            ? state.sessions.map((session) =>
                session.id === id ? { ...session, unreadCount: 0 } : session
              )
            : state.sessions;
          const sessionEvents = id
            ? state.sessionEvents.map((event) =>
                event.sessionId === id ? { ...event, read: true } : event
              )
            : state.sessionEvents;
          const unreadTotal = sessions.reduce((acc, session) => acc + (session.unreadCount ?? 0), 0);
          const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
          const nextWorkspace = activateTabInWorkspace(currentWorkspace, id, paneId);
          return {
            ...syncProjectState(state, path, sessions, nextWorkspace),
            sessionEvents,
            projectAttentionItems: {
              ...state.projectAttentionItems,
              [path]: markAttentionForSessionViewed(
                state.projectAttentionItems[path] ?? [],
                id ?? "",
                Date.now()
              ),
            },
            unreadTotal,
          };
        }),

      openTab: (tabId) =>
        set((state) => {
          // Launcher 模式：允许打开设置标签
          if (!state.currentProject) {
            if (tabId !== SETTINGS_ID) return state;
            const currentWorkspace = state.projectWorkspaces[LAUNCHER_WORKSPACE_KEY] || createDefaultWorkspace();
            const nextWorkspace = openTabInWorkspace(currentWorkspace, tabId, []);
            const normalizedWorkspace = normalizeWorkspace(nextWorkspace, []);
            return {
              ...state,
              projectWorkspaces: {
                ...state.projectWorkspaces,
                [LAUNCHER_WORKSPACE_KEY]: normalizedWorkspace,
              },
              windowMode: "project",
              ...syncWorkspaceSnapshot(normalizedWorkspace),
            };
          }

          const path = state.currentProject.path;
          const sessions = state.sessions.map((session) =>
            session.id === tabId ? { ...session, unreadCount: 0 } : session
          );
          const sessionEvents = state.sessionEvents.map((event) =>
            event.sessionId === tabId ? { ...event, read: true } : event
          );
          const unreadTotal = sessions.reduce((acc, session) => acc + (session.unreadCount ?? 0), 0);
          const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
          const nextWorkspace = openTabInWorkspace(currentWorkspace, tabId, sessions);
          return {
            ...syncProjectState(state, path, sessions, nextWorkspace),
            sessionEvents,
            projectAttentionItems: {
              ...state.projectAttentionItems,
              [path]: markAttentionForSessionViewed(
                state.projectAttentionItems[path] ?? [],
                tabId,
                Date.now()
              ),
            },
            unreadTotal,
          };
        }),

      openFileTab: (path, options) => {
        const normalizedPath = path.trim();
        if (!normalizedPath) return null;
        const tabId = getFileTabId(normalizedPath);
        const preview = options?.preview ?? true;
        set((state) => {
          if (!state.currentProject) return state;
          const projectPath = state.currentProject.path;
          const currentWorkspace = state.projectWorkspaces[projectPath] || createDefaultWorkspace();
          const nextWorkspace = cloneWorkspace(currentWorkspace);
          const pane = getActivePane(nextWorkspace);
          const now = Date.now();

          // In preview mode, remove existing preview tab from pane before adding the new one
          if (preview) {
            const existingPreviewId = pane.tabIds.find((id) => {
              const tab = nextWorkspace.tabsById[id];
              return tab?.preview && tab.kind === "file" && id !== tabId;
            });
            if (existingPreviewId) {
              pane.tabIds = pane.tabIds.filter((id) => id !== existingPreviewId);
              delete nextWorkspace.tabsById[existingPreviewId];
              if (pane.activeTabId === existingPreviewId) {
                pane.activeTabId = null;
              }
            }
          }

          nextWorkspace.tabsById[tabId] = nextWorkspace.tabsById[tabId] ?? createFileTab(normalizedPath, now);
          nextWorkspace.tabsById[tabId] = {
            ...nextWorkspace.tabsById[tabId],
            title: getFileName(normalizedPath),
            lastActivatedAt: now,
            preview: preview,
          };
          if (!pane.tabIds.includes(tabId)) {
            pane.tabIds.push(tabId);
          }
          pane.activeTabId = tabId;
          touchPaneHistory(pane, tabId);
          nextWorkspace.activePaneId = pane.id;
          nextWorkspace.focusedTabId = tabId;
          return {
            ...syncProjectState(state, projectPath, state.sessions, nextWorkspace),
            fileDocuments: {
              ...state.fileDocuments,
              [normalizedPath]: state.fileDocuments[normalizedPath] ?? {
                path: normalizedPath,
                name: getFileName(normalizedPath),
                kind: inferFileDocumentKind(normalizedPath),
                readOnly: false,
                sizeBytes: null,
                largeFile: false,
                modifiedAtMs: null,
              },
            },
          };
        });
        return tabId;
      },

      openGitDiffTab: (document) => {
        const normalizedPath = document.path.trim();
        if (!normalizedPath) return null;
        const tabId = getGitDiffTabId(
          normalizedPath,
          document.staged,
          document.revision,
        );
        set((state) => {
          if (!state.currentProject) return state;
          const projectPath = state.currentProject.path;
          const currentWorkspace = state.projectWorkspaces[projectPath] || createDefaultWorkspace();
          const nextWorkspace = cloneWorkspace(currentWorkspace);
          const pane = getActivePane(nextWorkspace);
          const now = Date.now();

          nextWorkspace.tabsById[tabId] =
            nextWorkspace.tabsById[tabId] ??
            createGitDiffTab(
              normalizedPath,
              document.staged,
              now,
              document.revision,
              document.modifiedLabel,
            );
          nextWorkspace.tabsById[tabId] = {
            ...nextWorkspace.tabsById[tabId],
            title: getGitDiffTitle(
              normalizedPath,
              document.staged,
              document.revision,
              document.modifiedLabel,
            ),
            lastActivatedAt: now,
            preview: false,
          };
          if (!pane.tabIds.includes(tabId)) {
            pane.tabIds.push(tabId);
          }
          pane.activeTabId = tabId;
          touchPaneHistory(pane, tabId);
          nextWorkspace.activePaneId = pane.id;
          nextWorkspace.focusedTabId = tabId;

          return {
            ...syncProjectState(state, projectPath, state.sessions, nextWorkspace),
            gitDiffDocuments: {
              ...state.gitDiffDocuments,
              [tabId]: {
                ...document,
                tabId,
                path: normalizedPath,
                name: getFileName(normalizedPath),
              },
            },
          };
        });
        return tabId;
      },

      promoteTab: (tabId) =>
        set((state) => {
          if (!state.currentProject) return state;
          const projectPath = state.currentProject.path;
          const currentWorkspace = state.projectWorkspaces[projectPath];
          if (!currentWorkspace) return state;
          const tab = currentWorkspace.tabsById[tabId];
          if (!tab || !tab.preview) return state;
          const nextWorkspace = cloneWorkspace(currentWorkspace);
          nextWorkspace.tabsById[tabId] = { ...tab, preview: false };
          return syncProjectState(state, projectPath, state.sessions, nextWorkspace);
        }),

      closeTab: (tabId, paneId) =>
        set((state) => {
          // Launcher 模式：关闭设置标签后回到 launcher
          if (!state.currentProject) {
            const currentWorkspace = state.projectWorkspaces[LAUNCHER_WORKSPACE_KEY] || createDefaultWorkspace();
            const nextWorkspace = closeTabInWorkspace(currentWorkspace, tabId, paneId);
            const normalizedWorkspace = normalizeWorkspace(nextWorkspace, []);
            const activePane = getActivePane(normalizedWorkspace);
            const hasRemainingTabs = activePane.tabIds.length > 0;

            if (!hasRemainingTabs) {
              return {
                ...state,
                projectWorkspaces: {
                  ...state.projectWorkspaces,
                  [LAUNCHER_WORKSPACE_KEY]: normalizedWorkspace,
                },
                windowMode: "launcher",
                tabsById: {},
                panesById: createDefaultWorkspace().panesById,
                layout: DEFAULT_LAYOUT,
                activePaneId: MAIN_PANE_ID,
                focusedTabId: null,
                openTabs: [],
                activeSessionId: null,
              };
            }

            return {
              ...state,
              projectWorkspaces: {
                ...state.projectWorkspaces,
                [LAUNCHER_WORKSPACE_KEY]: normalizedWorkspace,
              },
              ...syncWorkspaceSnapshot(normalizedWorkspace),
            };
          }

          const path = state.currentProject.path;
          const currentSessions = state.projectSessions[path] || [];
          const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
          const referenceCount = Object.values(currentWorkspace.panesById)
            .filter((pane) => pane.tabIds.includes(tabId)).length;
          const closingFinalReference = !paneId || referenceCount <= 1;
          const tab = state.tabsById[tabId];
          const targetSession = tab?.kind === "session"
            ? currentSessions.find((session) => session.id === tab.resourceId)
            : undefined;
          const sessions =
            tab?.kind === "session" && closingFinalReference
              ? targetSession && isEphemeralTerminalSession(targetSession)
                ? currentSessions.filter((session) => session.id !== tab.resourceId)
                : updateSessionCollection(currentSessions, tab.resourceId, {
                    active: false,
                    status: "stopped",
                  })
              : currentSessions;
          const nextWorkspace = closeTabInWorkspace(currentWorkspace, tabId, paneId);
          const nextDiffDocuments = { ...state.gitDiffDocuments };
          if (closingFinalReference) delete nextDiffDocuments[tabId];
          return {
            ...syncProjectState(state, path, sessions, nextWorkspace),
            gitDiffDocuments: nextDiffDocuments,
          };
        }),

      registerFileDocument: (document) =>
        set((state) => ({
          fileDocuments: {
            ...state.fileDocuments,
            [document.path]: document,
          },
        })),

      setTabDirty: (tabId, dirty) =>
        set((state) => {
          const tab = state.tabsById[tabId];
          if (!tab || tab.dirty === dirty || !state.currentProject) {
            return state;
          }
          const path = state.currentProject.path;
          const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
          const nextWorkspace = cloneWorkspace(currentWorkspace);
          nextWorkspace.tabsById[tabId] = {
            ...nextWorkspace.tabsById[tabId],
            dirty,
          };
          return syncProjectState(state, path, state.sessions, nextWorkspace);
        }),

      reorderTabs: (sourceTabId, targetTabId, position, paneId) =>
        set((state) => {
          if (!state.currentProject) return state;
          const path = state.currentProject.path;
          const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
          const nextWorkspace = reorderTabsInWorkspace(
            currentWorkspace,
            sourceTabId,
            targetTabId,
            position,
            paneId
          );
          return syncProjectState(state, path, state.sessions, nextWorkspace);
        }),

      moveTab: (tabId, sourcePaneId, targetPaneId, targetTabId, position) =>
        set((state) => {
          if (!state.currentProject) return state;
          const path = state.currentProject.path;
          const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
          const nextWorkspace = moveTabToPaneInWorkspace(
            currentWorkspace,
            tabId,
            sourcePaneId,
            targetPaneId,
            targetTabId,
            position
          );
          return syncProjectState(state, path, state.sessions, nextWorkspace);
        }),

      splitTab: (tabId, direction, paneId, mode) =>
        set((state) => {
          if (!state.currentProject) return state;
          const path = state.currentProject.path;
          const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
          const nextWorkspace = splitTabInWorkspace(
            currentWorkspace,
            tabId,
            direction,
            paneId,
            mode
          );
          return syncProjectState(state, path, state.sessions, nextWorkspace);
        }),

      setWorkspaceSplitRatio: (splitPath, ratio) =>
        set((state) => {
          if (!state.currentProject) return state;
          const path = state.currentProject.path;
          const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
          const nextWorkspace = cloneWorkspace(currentWorkspace);
          nextWorkspace.layout = {
            root: setLayoutSplitRatioAtPath(nextWorkspace.layout.root, splitPath, ratio),
          };
          return syncProjectState(state, path, state.sessions, nextWorkspace);
        }),

      setDragState: (dragState) => set({ dragState }),
      setResourceDragState: (resourceDragState) => set({ resourceDragState }),

      updateSession: (sessionId, updates) =>
        set((state) => {
          if (!state.currentProject) return state;
          const path = state.currentProject.path;
          const sessions = updateSessionCollection(
            state.projectSessions[path] || [],
            sessionId,
            updates
          );
          const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
          return {
            ...syncProjectState(state, path, sessions, currentWorkspace),
            projectAttentionItems: reconcileProjectAttentionItems(
              state.projectAttentionItems,
              path,
              state.sessionEvents,
              sessions
            ),
          };
        }),

      removeSession: (sessionId) =>
        set((state) => {
          if (!state.currentProject) return state;
          const path = state.currentProject.path;
          const sessions = (state.projectSessions[path] || []).filter(
            (session) => session.id !== sessionId
          );
          const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
          const nextWorkspace = closeTabInWorkspace(currentWorkspace, sessionId);
          return {
            ...syncProjectState(state, path, sessions, nextWorkspace),
            projectAttentionItems: {
              ...state.projectAttentionItems,
              [path]: transitionAttentionItems(
                state.projectAttentionItems[path] ?? [],
                (item) => item.sessionId === sessionId,
                "expired",
                "session-deleted",
                Date.now()
              ),
            },
          };
        }),

      removeAllSessions: () =>
        set((state) => {
          if (!state.currentProject) return state;
          const path = state.currentProject.path;
          const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
          const nextWorkspace = normalizeWorkspace(currentWorkspace, []);
          return {
            ...syncProjectState(state, path, [], nextWorkspace),
            projectAttentionItems: {
              ...state.projectAttentionItems,
              [path]: transitionAttentionItems(
                state.projectAttentionItems[path] ?? [],
                () => true,
                "expired",
                "sessions-cleared",
                Date.now()
              ),
            },
          };
        }),

      togglePinSession: (sessionId) =>
        set((state) => {
          if (!state.currentProject) return state;
          const path = state.currentProject.path;
          const targetSession = (state.projectSessions[path] || []).find((s) => s.id === sessionId);
          const willBePinned = targetSession ? !targetSession.pinned : false;
          const sessions = (state.projectSessions[path] || []).map((session) =>
            session.id === sessionId
              ? { ...session, pinned: !session.pinned }
              : session
          );
          const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
          const updates = syncProjectState(state, path, sessions, currentWorkspace);
          // Auto-expand pinned section when pinning a session
          if (willBePinned && state.sidebarPinnedCollapsed) {
            return { ...updates, sidebarPinnedCollapsed: false };
          }
          return updates;
        }),

      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setSidebarWidth: (width) =>
        set({
          sidebarWidth: clampSidebarWidth(width),
        }),
      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setActiveSidebarSection: (section) => set({ activeSidebarSection: section }),

      togglePinnedCollapsed: () =>
        set((state) => ({ sidebarPinnedCollapsed: !state.sidebarPinnedCollapsed })),

      toggleSessionsCollapsed: () =>
        set((state) => ({ sidebarSessionsCollapsed: !state.sidebarSessionsCollapsed })),

      setPinnedCollapsed: (collapsed) =>
        set({ sidebarPinnedCollapsed: collapsed }),

      toggleGitChangesCollapsed: () =>
        set((state) => ({ sidebarGitChangesCollapsed: !state.sidebarGitChangesCollapsed })),

      toggleGitGraphCollapsed: () =>
        set((state) => ({ sidebarGitGraphCollapsed: !state.sidebarGitGraphCollapsed })),

      setGitChangeCount: (count) => set({ gitChangeCount: count }),
      setGitSyncCounts: (ahead, behind) => set({ gitAheadCount: ahead, gitBehindCount: behind }),

      archiveSession: (sessionId) =>
        set((state) => {
          if (!state.currentProject) return state;
          const path = state.currentProject.path;
          const existingSessions = state.projectSessions[path] || [];
          const sessionToArchive = existingSessions.find((s) => s.id === sessionId);
          if (!sessionToArchive) return state;

          const sessions = existingSessions.filter((s) => s.id !== sessionId);
          const archivedSession = {
            ...sessionToArchive,
            active: false,
            status: "stopped" as const,
            archived: true,
            archivedAt: Date.now(),
          };
          const existingArchived = state.projectArchivedSessions[path] || [];
          const archivedSessions = [archivedSession, ...existingArchived];

          const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
          const nextWorkspace = closeTabInWorkspace(currentWorkspace, sessionId);

          return {
            ...syncProjectState(state, path, sessions, nextWorkspace),
            projectArchivedSessions: {
              ...state.projectArchivedSessions,
              [path]: archivedSessions,
            },
            projectAttentionItems: {
              ...state.projectAttentionItems,
              [path]: transitionAttentionItems(
                state.projectAttentionItems[path] ?? [],
                (item) => item.sessionId === sessionId,
                "resolved",
                "session-archived",
                archivedSession.archivedAt
              ),
            },
          };
        }),

      unarchiveSession: (projectPath, sessionId) =>
        set((state) => {
          const archivedSessions = state.projectArchivedSessions[projectPath] || [];
          const sessionToUnarchive = archivedSessions.find((s) => s.id === sessionId);
          if (!sessionToUnarchive) return state;

          const { archived: _, archivedAt: __, ...restoredSession } = sessionToUnarchive;
          const newArchived = archivedSessions.filter((s) => s.id !== sessionId);
          const existingSessions = state.projectSessions[projectPath] || [];
          const sessions = [restoredSession, ...existingSessions];

          const isCurrentProject = state.currentProject?.path === projectPath;
          if (isCurrentProject) {
            const currentWorkspace = state.projectWorkspaces[projectPath] || createDefaultWorkspace();
            return {
              ...syncProjectState(state, projectPath, sessions, currentWorkspace),
              projectArchivedSessions: {
                ...state.projectArchivedSessions,
                [projectPath]: newArchived,
              },
            };
          }

          return {
            projectSessions: { ...state.projectSessions, [projectPath]: sessions },
            projectArchivedSessions: {
              ...state.projectArchivedSessions,
              [projectPath]: newArchived,
            },
          };
        }),

      deleteArchivedSession: (projectPath, sessionId) =>
        set((state) => {
          const archivedSessions = (state.projectArchivedSessions[projectPath] || []).filter(
            (s) => s.id !== sessionId
          );
          return {
            projectArchivedSessions: {
              ...state.projectArchivedSessions,
              [projectPath]: archivedSessions,
            },
            projectAttentionItems: {
              ...state.projectAttentionItems,
              [projectPath]: transitionAttentionItems(
                state.projectAttentionItems[projectPath] ?? [],
                (item) => item.sessionId === sessionId,
                "expired",
                "session-deleted",
                Date.now()
              ),
            },
          };
        }),

      deleteAllArchivedSessions: (projectPath) =>
        set((state) => {
          const deletedIds = new Set(
            (state.projectArchivedSessions[projectPath] ?? []).map((session) => session.id)
          );
          return {
            projectArchivedSessions: {
              ...state.projectArchivedSessions,
              [projectPath]: [],
            },
            projectAttentionItems: {
              ...state.projectAttentionItems,
              [projectPath]: transitionAttentionItems(
                state.projectAttentionItems[projectPath] ?? [],
                (item) => deletedIds.has(item.sessionId),
                "expired",
                "session-deleted",
                Date.now()
              ),
            },
          };
        }),

      archiveAllSessionsInSection: (section) =>
        set((state) => {
          if (!state.currentProject) return state;
          const path = state.currentProject.path;
          const existingSessions = state.projectSessions[path] || [];

          const sessionsToArchive = existingSessions.filter((s) =>
            section === "pinned" ? s.pinned : !s.pinned
          );
          if (sessionsToArchive.length === 0) return state;

          const remainingSessions = existingSessions.filter((s) =>
            section === "pinned" ? !s.pinned : s.pinned
          );

          const archivedNow = sessionsToArchive.map((s) => ({
            ...s,
            active: false,
            status: "stopped" as const,
            archived: true,
            archivedAt: Date.now(),
          }));

          const existingArchived = state.projectArchivedSessions[path] || [];
          const archivedSessions = [...archivedNow, ...existingArchived];

          // Close tabs for archived sessions
          let currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
          for (const session of sessionsToArchive) {
            currentWorkspace = closeTabInWorkspace(currentWorkspace, session.id);
          }

          return {
            ...syncProjectState(state, path, remainingSessions, currentWorkspace),
            projectArchivedSessions: {
              ...state.projectArchivedSessions,
              [path]: archivedSessions,
            },
            projectAttentionItems: {
              ...state.projectAttentionItems,
              [path]: transitionAttentionItems(
                state.projectAttentionItems[path] ?? [],
                (item) => sessionsToArchive.some((session) => session.id === item.sessionId),
                "resolved",
                "session-archived",
                Date.now()
              ),
            },
          };
        }),

      setLightTheme: (theme) => set({ lightTheme: theme }),
      setDarkTheme: (theme) => set({ darkTheme: theme }),
      setThemeCategory: (category) => set({ themeCategory: category }),
      setSystemPrefersDark: (value) => set({ systemPrefersDark: value }),
      setLanguage: (language) => set({ language }),
      setStartupRestoreLastProject: (startupRestoreLastProject) =>
        set({ startupRestoreLastProject }),
      setEditorFontSize: (size) => set({ editorFontSize: size }),
      setTerminalFontSize: (size) => set({ terminalFontSize: size }),
      setTerminalCursorBlink: (blink) => set({ terminalCursorBlink: blink }),
      setTerminalLineHeight: (height) => set({ terminalLineHeight: height }),
      setTerminalRenderer: (renderer) => set({ terminalRenderer: renderer }),
      setDefaultTerminalShell: (shell) => set({ defaultTerminalShell: shell }),
      setTerminalQuickCommands: (commands) => set({ terminalQuickCommands: commands }),
      removeTerminalQuickCommand: (id) =>
        set((state) => ({
          terminalQuickCommands: state.terminalQuickCommands.filter((command) => command.id !== id),
        })),
      setAgentPermissionDefaults: (agentId, launchOptions) =>
        set((state) => ({
          agentPermissionDefaults: {
            ...state.agentPermissionDefaults,
            ...getPermissionDefaultsForLaunch(agentId, launchOptions),
          },
        })),
      setNotificationEnabled: (enabled) => set({ notificationEnabled: enabled }),
      setNotificationSoundEnabled: (enabled) => set({ notificationSoundEnabled: enabled }),
      setNotificationSoundMap: (event, sound) =>
        set((state) => ({
          notificationSoundMap: { ...state.notificationSoundMap, [event]: sound },
        })),
      setNotificationThreshold: (notificationThresholdMs) => set({ notificationThresholdMs }),
      setFeishuNotificationEnabled: (feishuNotificationEnabled) =>
        set({ feishuNotificationEnabled }),
      setFeishuNotificationThreshold: (feishuNotificationThresholdMs) =>
        set({ feishuNotificationThresholdMs }),
      setFeishuNotificationEvent: (event, enabled) =>
        set((state) => ({
          feishuNotificationEvents: { ...state.feishuNotificationEvents, [event]: enabled },
        })),
      upsertGitCloneTask: (task) =>
        set((state) => {
          const index = state.gitCloneTasks.findIndex((item) => item.taskId === task.taskId);
          if (index < 0) {
            return {
              gitCloneTasks: [...state.gitCloneTasks, task],
            };
          }
          const nextTasks = [...state.gitCloneTasks];
          nextTasks[index] = { ...nextTasks[index], ...task };
          return {
            gitCloneTasks: nextTasks,
          };
        }),
      removeGitCloneTask: (taskId) =>
        set((state) => ({
          gitCloneTasks: state.gitCloneTasks.filter((task) => task.taskId !== taskId),
        })),
      // Voice Recognition (ASR) actions
      setAsrApiKey: (apiKey) => set({ asrApiKey: apiKey }),
      setAsrAuthMode: (asrAuthMode) => set({ asrAuthMode: normalizeMimoAuthMode(asrAuthMode) }),
      setAsrModel: (model) => set({ asrModel: normalizeAsrModel(model) }),
      setAsrRegion: (asrRegion) => set({ asrRegion: normalizeDashScopeRegion(asrRegion) }),
      setVoiceShortcut: (keys) => set({ voiceShortcut: keys }),
      setVoiceInputTarget: (voiceInputTarget) => set({ voiceInputTarget }),
      setVoiceTriggerVisible: (voiceTriggerVisible) => set({ voiceTriggerVisible }),
      pushSessionEvent: (event) => {
        let outcome: "accepted" | "duplicate" | "stale" = "accepted";
        set((state) => {
          const eventKey = event.dedupeKey?.trim() || event.id;
          const duplicate = state.sessionEvents.some(
            (existing) => (existing.dedupeKey?.trim() || existing.id) === eventKey
          );
          if (duplicate) {
            outcome = "duplicate";
            return state;
          }

          const targetSession = state.sessions.find((session) => session.id === event.sessionId);
          const revision = event.revision ?? null;
          const staleByRevision =
            revision !== null &&
            targetSession?.statusRevision !== undefined &&
            revision < targetSession.statusRevision;
          const latestObservedAt = Math.max(
            targetSession?.lastEventAt ?? 0,
            targetSession?.statusUpdatedAt ?? 0,
          );
          const staleByTimestamp = event.createdAt < latestObservedAt;
          if (staleByRevision || staleByTimestamp) {
            outcome = "stale";
            return state;
          }

          const read = !event.requiresAttention || event.read === true;
          const events = [{ ...event, read }, ...state.sessionEvents].slice(0, 200);
          const unreadBySession = new Map<string, number>();
          for (const item of events) {
            if (item.requiresAttention && !item.read) {
              unreadBySession.set(item.sessionId, (unreadBySession.get(item.sessionId) ?? 0) + 1);
            }
          }
          const sessions = state.sessions.map((session) => {
            const unreadCount = unreadBySession.get(session.id) ?? 0;
            if (session.id !== event.sessionId) {
              return session.unreadCount === unreadCount ? session : { ...session, unreadCount };
            }
            const isNewestEvent = event.createdAt >= (session.lastEventAt ?? 0);
            return {
              ...session,
              // Hook attention events carry a revision and have a paired
              // agent-status update. They must not independently roll back
              // runtime state. Runtime PTY events remain the legacy fallback.
              status: revision === null ? mapStatusFromEvent(event.eventType) : session.status,
              unreadCount,
              lastEventAt: isNewestEvent ? event.createdAt : session.lastEventAt,
              lastEventType: isNewestEvent ? event.eventType : session.lastEventType,
            };
          });
          const unreadTotal = sessions.reduce((acc, session) => acc + (session.unreadCount ?? 0), 0);
          if (!state.currentProject) {
            return { sessionEvents: events, unreadTotal };
          }
          const path = state.currentProject.path;
          const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
          return {
            ...syncProjectState(state, path, sessions, currentWorkspace),
            sessionEvents: events,
            projectAttentionItems: reconcileProjectAttentionItems(
              state.projectAttentionItems,
              path,
              events,
              sessions
            ),
            unreadTotal,
          };
        });
        return outcome;
      },
      markSessionRead: (sessionId) =>
        set((state) => {
          const sessions = state.sessions.map((session) =>
            session.id === sessionId ? { ...session, unreadCount: 0 } : session
          );
          const sessionEvents = state.sessionEvents.map((event) =>
            event.sessionId === sessionId ? { ...event, read: true } : event
          );
          const unreadTotal = sessions.reduce((acc, session) => acc + (session.unreadCount ?? 0), 0);
          if (!state.currentProject) {
            return { sessionEvents, unreadTotal };
          }
          const path = state.currentProject.path;
          const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
          return {
            ...syncProjectState(state, path, sessions, currentWorkspace),
            sessionEvents,
            projectAttentionItems: {
              ...state.projectAttentionItems,
              [path]: markAttentionForSessionViewed(
                state.projectAttentionItems[path] ?? [],
                sessionId,
                Date.now()
              ),
            },
            unreadTotal,
          };
        }),
      focusSessionFromEvent: (event) =>
        set((state) => {
          const targetPath = event.projectPath;
          const nextProject = state.currentProject?.path === targetPath
            ? state.currentProject
            : {
                path: targetPath,
                name: targetPath.split(/[\\/]/).pop() || targetPath,
              };
          const targetSessions = (state.projectSessions[targetPath] || []).map((session) =>
            session.id === event.sessionId ? { ...session, unreadCount: 0 } : session
          );
          const currentWorkspace = state.projectWorkspaces[targetPath] || createDefaultWorkspace();
          const nextWorkspace = openTabInWorkspace(currentWorkspace, event.sessionId, targetSessions);
          return {
            currentProject: nextProject,
            recentProjects: touchRecentProjects(state.recentProjects, nextProject),
            sessionEvents: state.sessionEvents.map((item) =>
              item.sessionId === event.sessionId ? { ...item, read: true } : item
            ),
            projectAttentionItems: {
              ...state.projectAttentionItems,
              [targetPath]: markAttentionForSessionViewed(
                state.projectAttentionItems[targetPath] ?? [],
                event.sessionId,
                Date.now()
              ),
            },
            unreadTotal: targetSessions.reduce(
              (acc, session) => acc + (session.unreadCount ?? 0),
              0
            ),
            ...syncProjectState(state, targetPath, targetSessions, nextWorkspace),
          };
        }),
      markAttentionSeen: (id) =>
        set((state) => {
          const seenAt = Date.now();
          return {
            projectAttentionItems: updateAttentionAcrossProjects(
              state.projectAttentionItems,
              (items) =>
                items.map((item) =>
                  item.id === id && item.seenAt === undefined
                    ? { ...item, seenAt, updatedAt: Math.max(item.updatedAt, seenAt) }
                    : item
                )
            ),
          };
        }),
      resolveAttention: (id, reason) =>
        set((state) => ({
          projectAttentionItems: transitionAttentionById(
            state.projectAttentionItems,
            id,
            "resolved",
            reason,
            Date.now()
          ),
        })),
      dismissAttention: (id) =>
        set((state) => ({
          projectAttentionItems: transitionAttentionById(
            state.projectAttentionItems,
            id,
            "dismissed",
            "dismissed-by-user",
            Date.now()
          ),
        })),
      resolveAttentionForSession: (sessionId, reason) =>
        set((state) => ({
          projectAttentionItems: updateAttentionAcrossProjects(
            state.projectAttentionItems,
            (items) =>
              transitionAttentionItems(
                items,
                (item) => item.sessionId === sessionId,
                "resolved",
                reason,
                Date.now()
              )
          ),
        })),
      setAgentHookDiagnostic: (diagnostic) =>
        set((state) => ({
          attentionDiagnostics: {
            ...state.attentionDiagnostics,
            hooks: {
              ...state.attentionDiagnostics.hooks,
              [diagnostic.agentId]: diagnostic,
            },
          },
        })),
      recordAttentionEventDiagnostic: (lastEvent) =>
        set((state) => ({
          attentionDiagnostics: { ...state.attentionDiagnostics, lastEvent },
        })),
      recordNotificationDelivery: (lastNotification) =>
        set((state) => {
          const channel = lastNotification.channel ?? "system";
          return {
            attentionDiagnostics: {
              ...state.attentionDiagnostics,
              lastNotification,
              lastNotifications: {
                ...state.attentionDiagnostics.lastNotifications,
                [channel]: lastNotification,
              },
            },
          };
        }),
    };
};

function createPersistOptions(storage?: StateStorage) {
  return {
    name: "termflow-settings",
    version: 3,
    storage: createJSONStorage(() => storage ?? getDefaultStateStorage()),
    migrate: (persistedState: unknown) =>
      rehydrateMigrationState(persistedState as Partial<AppState> | undefined),
    partialize: (state: AppState) => {
      const projectSessions = withoutSessionHistoryExcludedSessions(state.projectSessions);
      const projectAttentionItems = sanitizePersistedAttentionItems(
        state.projectAttentionItems,
        projectSessions
      );
      return {
        lastProject: state.lastProject,
        recentProjects: state.recentProjects,
        sessionEvents: sanitizePersistedSessionEvents(
          state.sessionEvents,
          state.projectAttentionItems
        ),
        projectSessions,
        projectArchivedSessions: withoutSessionHistoryExcludedSessions(
          state.projectArchivedSessions
        ),
        projectWorkspaces: state.projectWorkspaces,
        projectAttentionItems,
        sidebarCollapsed: state.sidebarCollapsed,
        sidebarWidth: state.sidebarWidth,
        sidebarPinnedCollapsed: state.sidebarPinnedCollapsed,
        sidebarSessionsCollapsed: state.sidebarSessionsCollapsed,
        sidebarGitChangesCollapsed: state.sidebarGitChangesCollapsed,
        sidebarGitGraphCollapsed: state.sidebarGitGraphCollapsed,
      };
    },
    onRehydrateStorage: () => (state?: AppState) => {
      if (state) {
        state.windowContextReady = false;
        state.windowMode = "launcher";
        state.windowLabel = "main";
        state.windowProject = null;
        state.currentProject = null;
        state.claudeCliInfo = null;
        state.lastProject = state.lastProject ?? null;
        const { normalizedProjectSessions, recentProjects } =
          rehydrateRecentProjectState({
            projectSessions: withoutSessionHistoryExcludedSessions(state.projectSessions ?? {}),
            recentProjects: state.recentProjects,
          });
        state.projectSessions = normalizedProjectSessions;
        state.projectArchivedSessions = normalizeArchivedSessionGroups(
          state.projectArchivedSessions
        );
        state.recentProjects = recentProjects;
        state.sidebarWidth = clampSidebarWidth(state.sidebarWidth);
        // Do not restore previously opened tabs after app restart.
        state.projectWorkspaces = {};
        state.sessions = [];
        state.tabsById = {};
        state.panesById = createDefaultWorkspace().panesById;
        state.layout = DEFAULT_LAYOUT;
        state.activePaneId = MAIN_PANE_ID;
        state.focusedTabId = null;
        state.fileDocuments = {};
        state.openTabs = [];
        state.activeSessionId = null;
        state.dragState = null;
        state.projectAttentionItems = sanitizePersistedAttentionItems(
          state.projectAttentionItems,
          state.projectSessions
        );
        state.attentionDiagnostics = { hooks: {} };
        state.unreadTotal = 0;
        state.activeSidebarSection = "sessions";
      }
    },
  };
}

export function createAppStore(storage?: StateStorage) {
  return create<AppState>()(persist(createAppState, createPersistOptions(storage)));
}

export const useAppStore = createAppStore();

function rehydrateMigrationState(persistedState: Partial<AppState> | undefined) {
  const migratedState = migrateRecentProjectState(persistedState) as
    | Partial<AppState>
    | undefined;
  if (migratedState) {
    migratedState.asrAuthMode = normalizeMimoAuthMode(
      migratedState.asrAuthMode,
      migratedState.asrApiKey
    );
    migratedState.asrModel = normalizeAsrModel(migratedState.asrModel);
    migratedState.asrRegion = normalizeDashScopeRegion(migratedState.asrRegion);
    migratedState.voiceInputTarget = normalizeVoiceInputTarget(
      migratedState.voiceInputTarget
    );
    migratedState.terminalRenderer = normalizeTerminalRendererValue(
      migratedState.terminalRenderer
    );
    migratedState.voiceTriggerVisible = migratedState.voiceTriggerVisible ?? true;
    migratedState.startupRestoreLastProject = normalizeStartupRestoreLastProjectValue(
      migratedState.startupRestoreLastProject
    );
  }
  return migratedState;
}

function mapStatusFromEvent(eventType: SessionEventType): SessionRuntimeStatus {
  if (eventType === "session_started" || eventType === "session_resumed") return "waiting";
  if (eventType === "assistant_complete") return "completed";
  if (eventType === "waiting_input" || eventType === "permission_request") return "waiting";
  if (eventType === "process_error" || eventType === "hook_error") return "error";
  if (eventType === "process_exit") return "stopped";
  return "running";
}
