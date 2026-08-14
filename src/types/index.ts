export interface SessionContextUsage {
  usedTokens: number;
  totalTokens: number | null;
  ratio: number | null;
  model?: string | null;
  usageSource: "transcript";
  contextWindowSource: "telemetry-model" | "model-estimate" | "unknown";
  updatedAt: number;
}

export interface PersistentNotificationSoundMap {
  taskComplete: string;
  error: string;
  waiting: string;
}

export interface PersistentFeishuNotificationEvents {
  completed: boolean;
  error: boolean;
  waiting: boolean;
  permission: boolean;
}

export interface PersistentSettings {
  lightTheme: string;
  darkTheme: string;
  themeCategory: string;
  language: string;
  startupRestoreLastProject: boolean;
  projectOpenBehavior: ProjectOpenBehavior;
  lastProjectPath: string | null;
  editorFontSize: number;
  terminalFontSize: number;
  terminalCursorBlink: boolean;
  terminalLineHeight: number;
  terminalRenderer: string;
  agentPermissionDefaults: AgentPermissionDefaults;
  notificationEnabled: boolean;
  notificationSoundEnabled: boolean;
  notificationSoundMap: PersistentNotificationSoundMap;
  notificationThresholdMs: number;
  feishuNotificationEnabled: boolean;
  feishuNotificationThresholdMs: number;
  feishuNotificationEvents: PersistentFeishuNotificationEvents;
  asrApiKey: string;
  asrAuthMode: string;
  asrModel: string;
  asrRegion: string;
  voiceShortcut: string;
  voiceInputTarget: string;
  voiceTriggerVisible: boolean;
  terminalQuickCommands: TerminalQuickCommand[];
  defaultAgentId: AiAgentId | null;
}

// ── 快速命令类型 ──────────────────────────────────────────────

export type QuickCommandScope =
  | { type: 'global' }
  | { type: 'repository'; repositoryId: string }

export type QuickCommandAction = 'terminal-command' | 'agent-prompt';

export interface TerminalQuickCommand {
  id: string;
  label: string;
  scope: QuickCommandScope;
  action: QuickCommandAction;
  command: string;
  appendEnter: boolean;
  agentId?: AiAgentId;
}

export interface SessionUsageUpdatePayload {
  sessionId: string;
  usedTokens: number;
  contextWindow: number | null;
  usageRatio: number | null;
  model?: string | null;
  usageSource: "transcript";
  contextWindowSource: "telemetry-model" | "model-estimate" | "unknown";
  updatedAt: number;
}

export interface Session {
  id: string;
  path: string;
  name: string;
  createdAt: number;
  active: boolean;
  /** Runtime-only terminal tab; excluded from resumable session history. */
  ephemeral?: boolean;
  /** Preferred presentation surface. Runtime and Agent capabilities are unchanged. */
  presentation?: "workspace" | "auxiliary";
  hasPromptHistory?: boolean;
  pinned?: boolean;
  archived?: boolean;
  archivedAt?: number;
  titleSource?: "default" | "auto" | "manual";
  firstPromptTitle?: string;
  status?: "starting" | "running" | "waiting" | "completed" | "error" | "stopped";
  unreadCount?: number;
  lastEventAt?: number;
  lastEventType?: string;
  statusRevision?: number;
  statusUpdatedAt?: number;
  runtimeModel?: string | null;
  runtimeMode?: ClaudeSessionMode | null;
  runtimeEffort?: ClaudeEffortLevel | null;
  runtimeSilent?: boolean;
  runtimeDetectionSource?: "pty" | "command" | null;
  runtimeUpdatedAt?: number;
  contextUsage?: SessionContextUsage | null;
  agentId?: AgentId;
  agentExecutablePath?: string | null;
  agentSessionId?: string | null;
  claudeSkipPermissions?: boolean | null;
  antigravityDangerouslySkipPermissions?: boolean | null;
  antigravitySandbox?: boolean | null;
  antigravityMode?: AntigravitySessionLaunchOptions["mode"] | null;
  qoderPermissionMode?: QoderSessionLaunchOptions["permissionMode"] | null;
  checkpointActiveTurnId?: string | null;
  checkpointPendingTurns?: number;
  checkpointFileCount?: number;
  checkpointInsertions?: number;
  checkpointDeletions?: number;
  checkpointReviewStatus?: CheckpointReviewStatus | null;
  checkpointUpdatedAt?: number;
  checkpointWarning?: string | null;
}

export type ClaudeSessionMode = "default" | "auto" | "accept-edits" | "plan";
export type ClaudeEffortLevel =
  | "auto"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultracode";

export interface ClaudeCliInfo {
  available: boolean;
  version: string | null;
  executablePath: string | null;
  checkedAt: number;
  error?: string | null;
}

export const AI_AGENT_IDS = [
  "claude",
  "codex",
  "antigravity",
  "opencode",
  "qoder",
] as const;

export type AiAgentId = (typeof AI_AGENT_IDS)[number];

export type AgentId = AiAgentId | "powershell" | "cmd";

export interface AgentCliInfo {
  id: AiAgentId;
  name: string;
  command: string;
  installed: boolean;
  version: string | null;
  executablePath: string | null;
  checkedAt: number;
  error: string | null;
}

export interface ClaudeSessionLaunchOptions {
  skipPermissions: boolean;
  effort: "inherit" | ClaudeEffortLevel;
}

export interface CodexSessionLaunchOptions {
  yolo: boolean;
  approvalMode: "untrusted" | "on-request" | "never";
  sandboxMode: "workspace-write" | "read-only";
  effort: "inherit" | "low" | "medium" | "high";
}

export interface AntigravitySessionLaunchOptions {
  dangerouslySkipPermissions: boolean;
  sandbox: boolean;
  mode: "inherit" | "accept-edits" | "plan";
}

export interface QoderSessionLaunchOptions {
  permissionMode:
    | "inherit"
    | "default"
    | "accept_edits"
    | "plan"
    | "bypass_permissions"
    | "dont_ask"
    | "auto";
}

export type SessionLaunchOptions =
  | ClaudeSessionLaunchOptions
  | CodexSessionLaunchOptions
  | AntigravitySessionLaunchOptions
  | QoderSessionLaunchOptions;

/**
 * User-level launch preferences for the permission-related controls exposed by
 * each agent. Options unrelated to permissions, such as model effort, are
 * intentionally excluded so a successful launch only becomes the next
 * default for its permission mode.
 */
export interface AgentPermissionDefaults {
  claude?: Pick<ClaudeSessionLaunchOptions, "skipPermissions">;
  codex?: Pick<
    CodexSessionLaunchOptions,
    "yolo" | "approvalMode" | "sandboxMode"
  >;
  antigravity?: Pick<
    AntigravitySessionLaunchOptions,
    "dangerouslySkipPermissions" | "sandbox" | "mode"
  >;
  qoder?: Pick<QoderSessionLaunchOptions, "permissionMode">;
}

export type NewSessionLaunchRequest =
  | { kind: "agent"; agent: AgentCliInfo; launchOptions?: SessionLaunchOptions }
  | { kind: "terminal"; shell: "powershell" | "cmd" };

export interface ClaudeEffortInfo {
  effectiveLevel: ClaudeEffortLevel;
  configuredLevel: ClaudeEffortLevel | null;
  source: string;
  configPath: string | null;
}

export interface ClaudeThemeInfo {
  theme: string;
  configuredTheme: string | null;
  configPath: string;
}

export type UsageTelemetryCapability = "full" | "partial" | "unsupported" | "unknown";

export interface AgentUsageProviderSummary {
  agent: AiAgentId;
  label: string;
  capability: UsageTelemetryCapability;
  source: string;
  totalTokens: number;
  totalSessions: number;
  totalMessages: number;
  activeDays: number;
  favoriteModel: string | null;
  lastError: string | null;
}

export interface AgentUsageHeatmapDay {
  date: string;
  tokenCount: number;
}

export interface AgentUsageDailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
}

export interface AgentUsageDailyModelTokens {
  date: string;
  tokensByModel: Record<string, number>;
}

export interface AgentUsageTokenBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningOutputTokens: number;
  otherTokens: number;
  totalTokens: number;
}

export interface AgentUsageOverviewSummary {
  totalTokens: number;
  totalMessages: number;
  peakDailyTokens: number;
  longestSessionMs: number;
  currentStreakDays: number;
  longestStreakDays: number;
  totalSessions: number;
  activeDays: number;
  totalDays: number;
  favoriteModel: string | null;
  peakHour: number | null;
}

export interface AgentUsageOverview {
  lastComputedDate: string | null;
  summary: AgentUsageOverviewSummary;
  tokenBreakdown: AgentUsageTokenBreakdown;
  heatmap: AgentUsageHeatmapDay[];
  dailyActivity: AgentUsageDailyActivity[];
  dailyModelTokens: AgentUsageDailyModelTokens[];
  providers: AgentUsageProviderSummary[];
}

export type AgentUsageHistoryScope = "codex" | "all";

export interface AgentUsageStorageStatus {
  agent: "codex";
  retainedSessions: number;
  lastSyncedAtMs: number | null;
  clearedAtMs: number | null;
  lastError: string | null;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number | null;
  resetDescription: string | null;
}

export interface CodexRateLimitResetCredits {
  availableCount: number;
  totalEarnedCount?: number | null;
  nextExpiresAt?: number | null;
}

export type CodexRateLimitStatus = "ok" | "error" | "unavailable";

export interface CodexRateLimits {
  session: CodexRateLimitWindow | null;
  weekly: CodexRateLimitWindow | null;
  rateLimitResetCredits?: CodexRateLimitResetCredits | null;
  updatedAt: number;
  error: string | null;
  status: CodexRateLimitStatus;
  accountLabel: string | null;
  accountId: string | null;
}

export type ClaudeRateLimitStatus = "ok" | "unavailable";

export interface ClaudeRateLimits {
  session: CodexRateLimitWindow | null;
  weekly: CodexRateLimitWindow | null;
  updatedAt: number;
  error: string | null;
  status: ClaudeRateLimitStatus;
}

export interface ClaudeRateLimitsUpdatePayload extends ClaudeRateLimits {
  sessionId: string;
}

export type ClaudeMdScope = "user" | "workspace" | "local";

export interface ClaudeMdDetail {
  scope: ClaudeMdScope;
  filePath: string;
  directoryPath: string;
  exists: boolean;
  content: string;
  source: "user" | "workspace-root" | "workspace-dot-claude" | "local" | string;
  updatedAt?: number | null;
}

export type WindowMode = "launcher" | "project";
export type ProjectOpenBehavior = "ask" | "current_window" | "new_window";
export type ProjectOpenDisposition = "auto" | "current_window" | "new_window";

export interface WindowProjectContext {
  windowLabel: string;
  mode: WindowMode;
  projectPath?: string | null;
  projectName?: string | null;
}

export type FileTreeEntryKind = "file" | "directory";

export interface FileTreeEntry {
  name: string;
  path: string;
  kind: FileTreeEntryKind;
  hasChildren: boolean;
}

export interface FileTreeListing {
  rootPath: string;
  directoryPath: string;
  entries: FileTreeEntry[];
}

export interface ProjectLinkTarget {
  path: string;
  kind: FileTreeEntryKind;
}

export interface ProjectFileContent {
  path: string;
  name: string;
  content: string;
  kind: "text" | "image" | "pdf" | "binary";
  readOnly: boolean;
  sizeBytes: number;
  largeFile: boolean;
  modifiedAtMs?: number | null;
}

export interface ProjectFileStatus {
  path: string;
  name: string;
  kind: "text" | "image" | "pdf" | "binary";
  readOnly: boolean;
  sizeBytes: number;
  largeFile: boolean;
  modifiedAtMs?: number | null;
}

export interface ProjectImagePayload {
  path: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  sizeBytes: number;
}

export interface ContentSearchRequest {
  searchId: string;
  projectPath: string;
  scopePath?: string | null;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  includePatterns: string[];
  excludePatterns: string[];
}

export interface ContentSearchMatch {
  path: string;
  relativePath: string;
  lineNumber: number;
  startColumn: number;
  endColumn: number;
  lineText: string;
  contextBefore: string[];
  contextAfter: string[];
}

export interface ContentSearchBatch {
  searchId: string;
  matches: ContentSearchMatch[];
}

export interface ContentSearchSummary {
  searchId: string;
  scannedFiles: number;
  skippedFiles: number;
  matchedFiles: number;
  matchCount: number;
  durationMs: number;
  truncated: boolean;
  cancelled: boolean;
}

export interface SavedImagePayload {
  path: string;
  fileName: string;
  size: number;
}

export type SkillScope = "workspace" | "user";
export type SkillAgent = AiAgentId;

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  scope: SkillScope;
  agent: SkillAgent;
  effectiveAgents: SkillAgent[];
  hasNameConflict: boolean;
  folderName: string;
  filePath: string;
  sourceDir: string;
  updatedAt?: number;
}

export interface SkillRootInfo {
  agent: SkillAgent;
  scope: SkillScope;
  enabledDir?: string | null;
  disabledDir?: string | null;
}

export interface SkillCatalog {
  skills: SkillInfo[];
  roots: SkillRootInfo[];
}

export interface SkillDetail {
  skill: SkillInfo;
  content: string;
}

export type CommandScope = "workspace" | "user";
export type CommandShell = "default" | "powershell" | "cmd" | "bash";
export type CommandCwdMode = "project" | "current" | "custom";

export interface CommandInfo {
  id: string;
  name: string;
  description: string;
  scope: CommandScope;
  format: "claude_native" | "extended" | string;
  allowedTools: string[];
  supportsTestRun: boolean;
  template: string;
  commandPreview: string;
  shell: CommandShell;
  cwdMode: CommandCwdMode;
  cwdPath?: string | null;
  tags: string[];
  requiresConfirm: boolean;
  runInNewSession: boolean;
  filePath: string;
  sourceDir: string;
  updatedAt: number;
}

export interface CommandCatalog {
  commands: CommandInfo[];
  workspaceDir?: string | null;
  userDir: string;
}

export interface CommandDetail {
  command: CommandInfo;
  content: string;
}

export interface CommandDraft {
  name: string;
  description?: string;
  template: string;
  shell?: CommandShell;
  cwdMode?: CommandCwdMode;
  cwdPath?: string;
  tags?: string[];
  requiresConfirm?: boolean;
  runInNewSession?: boolean;
}

export interface CommandTestResult {
  success: boolean;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  resolvedCommand: string;
  workingDirectory: string;
  shell: CommandShell;
  durationMs: number;
}

export type HookScope = "workspace" | "user";
export type HookAgent = AiAgentId;

export interface HookInfo {
  agent: HookAgent;
  id: string;
  name: string;
  enabled: boolean;
  scope: HookScope;
  event: string;
  matcher: string;
  command: string;
  commandPreview: string;
  timeout?: number;
  configPath: string;
  updatedAt?: number;
}

export interface HookCatalog {
  hooks: HookInfo[];
  workspaceConfigPath?: string | null;
  userConfigPath: string;
}

export interface HookDetail {
  hook: HookInfo;
  rawConfig: string;
}

export interface SessionGroup {
  id: string;
  name: string;
  path: string;
  sessions: Session[];
}

// Git types

export type GitStatusType =
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "renamed"
  | "typechange"
  | "conflicted";

export interface GitFileStatus {
  path: string;
  oldPath?: string | null;
  statusType: GitStatusType;
  staged: boolean;
  insertions?: number | null;
  deletions?: number | null;
}

export interface GitBranchInfo {
  branchName: string;
  ahead: number;
  behind: number;
  isDetached: boolean;
}

export interface GitDiffResult {
  filePath: string;
  diffText: string;
  isBinary: boolean;
}

export interface GitDiffContentResult {
  filePath: string;
  originalContent: string;
  modifiedContent: string;
  isBinary: boolean;
  contentKind?: "text" | "binary" | "gitlink";
  originalLabel: string;
  modifiedLabel: string;
}

export interface GitCommitResult {
  commitOid: string;
  message: string;
}

export interface GitRepoInfo {
  isRepo: boolean;
  branchInfo: GitBranchInfo | null;
}

export interface GitRemoteResult {
  success: boolean;
  message: string;
}

export interface GitCloneResult {
  projectPath: string;
}

export interface GitCloneStartResult {
  taskId: string;
  projectPath: string;
  directoryName: string;
}

export type GitCloneTaskStatus = "starting" | "progress" | "completed" | "failed" | "cancelled";

export interface GitCloneTask {
  taskId: string;
  status: GitCloneTaskStatus;
  projectPath: string;
  directoryName: string;
  remoteUrl: string;
  stage: string | null;
  progressPercent: number | null;
  current: number | null;
  total: number | null;
  transferred: string | null;
  speed: string | null;
  detail: string | null;
  error: string | null;
}

export interface GitCloneEventPayload {
  taskId: string;
  status: GitCloneTaskStatus;
  projectPath: string;
  directoryName: string;
  remoteUrl: string;
  stage?: string | null;
  progressPercent?: number | null;
  current?: number | null;
  total?: number | null;
  transferred?: string | null;
  speed?: string | null;
  detail?: string | null;
  error: string | null;
}

export interface GitGraphRef {
  name: string;
  kind: string;
}

export interface GitGraphCommit {
  oid: string;
  shortOid: string;
  summary: string;
  authorName: string;
  authorEmail: string;
  timestampMs: number;
  parentOids: string[];
  refs: GitGraphRef[];
}

export interface GitGraphChangedFile {
  path: string;
  oldPath: string | null;
  status: string;
}


export interface GitGraphCommitDetail {
  oid: string;
  body: string;
  changedFiles: number;
  insertions: number;
  deletions: number;
  files: GitGraphChangedFile[];
}

export interface GitBranchListItem {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface GitDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: GitDiffLine[];
  decision?: CheckpointReviewDecision;
}

export interface GitDiffLine {
  origin: string;  // ' ', '+', '-'
  content: string;
  oldLineno: number | null;
  newLineno: number | null;
}

export interface GitDiffHunkResult {
  filePath: string;
  hunks: GitDiffHunk[];
}

export type CheckpointReviewDecision = "pending" | "accepted" | "rejected";
export type CheckpointReviewStatus =
  | "running"
  | "no_changes"
  | "awaiting_review"
  | "partially_reviewed"
  | "reviewed"
  | "restored";

export interface CheckpointSnapshot {
  commitOid: string;
  treeOid: string;
  reference: string;
  createdAt: number;
}

export interface CheckpointChangedFile {
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "renamed" | "copied" | "typechange" | "modified" | string;
  insertions: number | null;
  deletions: number | null;
  isBinary: boolean;
  decision: CheckpointReviewDecision;
}

export interface AgentTurnReview {
  version: number;
  id: string;
  sessionId: string;
  agentId: string;
  projectPath: string;
  startedAt: number;
  completedAt: number | null;
  completionSource: string | null;
  attributionConfidence: "strong" | "medium" | "ambiguous" | string;
  baseline: CheckpointSnapshot;
  result: CheckpointSnapshot | null;
  files: CheckpointChangedFile[];
  hunkDecisions: Record<string, CheckpointReviewDecision>;
  insertions: number;
  deletions: number;
  reviewStatus: CheckpointReviewStatus;
  reviewedAt: number | null;
  updatedAt: number;
}

export interface AgentTurnStartResult {
  turn: AgentTurnReview | null;
  completedPrevious: AgentTurnReview | null;
  warning: string | null;
}

export interface CheckpointRestoreResult {
  safetyCheckpoint: CheckpointSnapshot;
  turn: AgentTurnReview;
}

export interface GitConflictDetail {
  filePath: string;
  hasConflict: boolean;
  oursContent: string | null;
  theirsContent: string | null;
  baseContent: string | null;
  mergedContent: string | null;
}

// MCP Server types

export type McpServerType = "stdio" | "sse" | "http" | "ws";

export interface McpServerConfig {
  type?: McpServerType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  cwd?: string;
}

export interface McpServerInfo {
  name: string;
  serverType: McpServerType;
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
  cwd?: string;
  scope: "local" | "project" | "workspace" | "user";
  configPath: string;
}

export interface McpServerCatalog {
  servers: McpServerInfo[];
  scopeConfigPaths: Record<string, string>;
  workspaceConfigPath?: string | null;
  userConfigPath: string;
}

export interface McpServerTestResult {
  success: boolean;
  message: string;
}
