import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AI_AGENT_ORDER, isAiAgentId } from "@/lib/agents";
import type {
  AiAgentId,
  AgentUsageHistoryScope,
  AgentUsageOverview,
  AgentUsageStorageStatus,
  CodexRateLimits,
  ClaudeRateLimits,
  ClaudeCliInfo,
  AgentCliInfo,
  ClaudeEffortInfo,
  ClaudeMdDetail,
  ClaudeMdScope,
  ClaudeThemeInfo,
  FileTreeEntry,
  FileTreeListing,
  PersistentSettings,
  ProjectOpenDisposition,
  ProjectFileContent,
  ProjectImagePayload,
  ProjectLinkTarget,
  ProjectFileStatus,
  ContentSearchRequest,
  ContentSearchSummary,
  ProjectSearchIndexStatus,
  SearchIndexStorageStatus,
  SavedImagePayload,
  WindowProjectContext,
  SkillCatalog,
  SkillDetail,
  SkillAgent,
  SkillInfo,
  SkillScope,
  CommandCatalog,
  CommandDetail,
  CommandDraft,
  CommandInfo,
  CommandScope,
  CommandTestResult,
  HookCatalog,
  HookDetail,
  HookAgent,
  HookScope,
  WorkspaceHookMigrationResult,
  McpServerCatalog,
  McpServerConfig,
  McpServerInfo,
  McpServerTestResult,
  GitBranchInfo,
  GitBranchListItem,
  GitCommitResult,
  GitConflictDetail,
  GitDiffContentResult,
  GitDiffHunkResult,
  GitDiffResult,
  GitFileStatus,
  GitRemoteResult,
  GitCloneStartResult,
  GitGraphCommit,
  GitGraphCommitDetail,
  GitRepoInfo,
  AgentTurnReview,
  AgentTurnStartResult,
  CheckpointRestoreResult,
  CheckpointReviewDecision,
} from "@/types";

export async function spawnPty(
  sessionId: string,
  path: string,
  resume?: boolean,
  skipPermissions?: boolean,
  startupCommand?: string,
  initialPrompt?: string,
  shellType?: string,
  claudeEffort?: string,
  agentId?: string,
): Promise<void> {
  await invoke("spawn_pty", {
    sessionId,
    path,
    resume: resume ?? false,
    skipPermissions: skipPermissions ?? false,
    startupCommand: startupCommand ?? null,
    initialPrompt: initialPrompt ?? null,
    shellType: shellType ?? null,
    claudeEffort: claudeEffort ?? null,
    agentId: agentId ?? null,
  });
}

export interface AgentHookStatus {
  agent: string;
  configured: boolean;
  configPath: string;
  detail?: string | null;
}

export async function ensureAgentStatusHook(agentId: string): Promise<AgentHookStatus> {
  return await invoke("ensure_agent_status_hook", { agentId });
}

export async function resolveRecentCodexSessionId(
  projectPath: string,
  sinceTimestampMs?: number,
): Promise<string | null> {
  return await invoke("resolve_recent_codex_session_id", {
    projectPath,
    sinceTimestampMs: sinceTimestampMs ?? null,
  });
}

export async function checkClaudeReady(): Promise<void> {
  await invoke("check_claude_ready");
}

export async function getClaudeCliInfo(): Promise<ClaudeCliInfo> {
  return await invoke("get_claude_cli_info");
}

const AGENT_CLI_CACHE_KEY = "termflow.agent-cli-inspection.v2";

let agentCliInspectionCache: AgentCliInfo[] | null = null;
let agentCliInspectionRequest: Promise<AgentCliInfo[]> | null = null;

function isAgentCliInfo(value: unknown): value is AgentCliInfo {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AgentCliInfo>;
  return (
    isAiAgentId(candidate.id) &&
    typeof candidate.name === "string" &&
    typeof candidate.command === "string" &&
    typeof candidate.installed === "boolean" &&
    typeof candidate.checkedAt === "number"
  );
}

function isCompleteAgentCliInspection(value: unknown): value is AgentCliInfo[] {
  if (!Array.isArray(value) || value.length !== AI_AGENT_ORDER.length) return false;
  if (!value.every(isAgentCliInfo)) return false;

  const detectedIds = new Set(value.map((agent) => agent.id));
  return detectedIds.size === AI_AGENT_ORDER.length &&
    AI_AGENT_ORDER.every((agentId) => detectedIds.has(agentId));
}

function readPersistedAgentCliInspection(): AgentCliInfo[] | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(AGENT_CLI_CACHE_KEY) ?? "null");
    return isCompleteAgentCliInspection(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persistAgentCliInspection(agents: AgentCliInfo[]) {
  if (!isCompleteAgentCliInspection(agents)) return;
  agentCliInspectionCache = agents;
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(AGENT_CLI_CACHE_KEY, JSON.stringify(agents));
  } catch (error) {
    console.warn("Failed to persist agent CLI inspection:", error);
  }
}

/**
 * Return the last successful inspection across pages and app restarts.
 * Only an explicit force refresh starts the CLI processes again.
 */
export async function inspectAgentClis(options?: {
  forceRefresh?: boolean;
}): Promise<AgentCliInfo[]> {
  if (!options?.forceRefresh) {
    agentCliInspectionCache ??= readPersistedAgentCliInspection();
    if (agentCliInspectionCache) return agentCliInspectionCache;
  }

  // Page transitions can mount multiple consumers at once. Share one native
  // inspection so each CLI is never probed more than once per refresh.
  if (agentCliInspectionRequest) return agentCliInspectionRequest;

  agentCliInspectionRequest = invoke<AgentCliInfo[]>("inspect_agent_clis")
    .then((agents) => {
      if (!isCompleteAgentCliInspection(agents)) {
        throw new Error("Native and frontend agent registries are out of sync");
      }
      const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
      const orderedAgents = AI_AGENT_ORDER.map((agentId) => agentsById.get(agentId)!);
      persistAgentCliInspection(orderedAgents);
      return orderedAgents;
    })
    .finally(() => {
      agentCliInspectionRequest = null;
    });

  return agentCliInspectionRequest;
}

export async function getClaudeEffortInfo(
  projectPath?: string | null
): Promise<ClaudeEffortInfo> {
  return await invoke("get_claude_effort_info", { projectPath: projectPath ?? null });
}

const AGENT_USAGE_OVERVIEW_CACHE_TTL_MS = 5 * 60 * 1000;
export const AGENT_USAGE_HISTORY_CHANGED_EVENT = "termflow:agent-usage-history-changed";

let agentUsageOverviewCache:
  | { value: AgentUsageOverview; updatedAt: number }
  | null = null;
let agentUsageOverviewRequest: Promise<AgentUsageOverview> | null = null;

export function getCachedAgentUsageOverview(
  maxAgeMs = AGENT_USAGE_OVERVIEW_CACHE_TTL_MS
): AgentUsageOverview | null {
  if (!agentUsageOverviewCache) {
    return null;
  }

  if (Date.now() - agentUsageOverviewCache.updatedAt > maxAgeMs) {
    return null;
  }

  return agentUsageOverviewCache.value;
}

export function getCachedAgentUsageOverviewUpdatedAt(): number | null {
  return agentUsageOverviewCache?.updatedAt ?? null;
}

export function clearAgentUsageOverviewCache(): void {
  agentUsageOverviewCache = null;
  agentUsageOverviewRequest = null;
}

function notifyAgentUsageHistoryChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AGENT_USAGE_HISTORY_CHANGED_EVENT));
  }
}

export async function getAgentUsageOverview(options?: {
  forceRefresh?: boolean;
  maxAgeMs?: number;
}): Promise<AgentUsageOverview> {
  const maxAgeMs = options?.maxAgeMs ?? AGENT_USAGE_OVERVIEW_CACHE_TTL_MS;
  const cached = options?.forceRefresh ? null : getCachedAgentUsageOverview(maxAgeMs);
  if (cached) {
    return cached;
  }

  if (!options?.forceRefresh && agentUsageOverviewRequest) {
    return agentUsageOverviewRequest;
  }

  agentUsageOverviewRequest = invoke<AgentUsageOverview>("get_agent_usage_overview")
    .then((value) => {
      agentUsageOverviewCache = {
        value,
        updatedAt: Date.now(),
      };
      return value;
    })
    .finally(() => {
      agentUsageOverviewRequest = null;
    });

  return await agentUsageOverviewRequest;
}

export async function getAgentUsageStorageStatus(): Promise<AgentUsageStorageStatus> {
  return await invoke<AgentUsageStorageStatus>("get_agent_usage_storage_status");
}

export async function clearAgentUsageHistory(
  scope: AgentUsageHistoryScope
): Promise<AgentUsageStorageStatus> {
  const status = await invoke<AgentUsageStorageStatus>("clear_agent_usage_history", { scope });
  clearAgentUsageOverviewCache();
  notifyAgentUsageHistoryChanged();
  return status;
}

export async function rebuildAgentUsageHistory(
  scope: AgentUsageHistoryScope
): Promise<AgentUsageStorageStatus> {
  const status = await invoke<AgentUsageStorageStatus>("rebuild_agent_usage_history", { scope });
  clearAgentUsageOverviewCache();
  notifyAgentUsageHistoryChanged();
  return status;
}

const CODEX_RATE_LIMITS_CACHE_TTL_MS = 60 * 1000;

let codexRateLimitsCache:
  | { value: CodexRateLimits; updatedAt: number }
  | null = null;
let codexRateLimitsRequest: Promise<CodexRateLimits> | null = null;

export function getCachedCodexRateLimits(
  maxAgeMs = CODEX_RATE_LIMITS_CACHE_TTL_MS
): CodexRateLimits | null {
  if (!codexRateLimitsCache) {
    return null;
  }

  if (Date.now() - codexRateLimitsCache.updatedAt > maxAgeMs) {
    return null;
  }

  return codexRateLimitsCache.value;
}

export async function getCodexRateLimits(options?: {
  forceRefresh?: boolean;
  maxAgeMs?: number;
}): Promise<CodexRateLimits> {
  const maxAgeMs = options?.maxAgeMs ?? CODEX_RATE_LIMITS_CACHE_TTL_MS;
  const cached = options?.forceRefresh ? null : getCachedCodexRateLimits(maxAgeMs);
  if (cached) {
    return cached;
  }

  if (!options?.forceRefresh && codexRateLimitsRequest) {
    return codexRateLimitsRequest;
  }

  codexRateLimitsRequest = invoke<CodexRateLimits>("get_codex_rate_limits")
    .then((value) => {
      codexRateLimitsCache = {
        value,
        updatedAt: Date.now(),
      };
      return value;
    })
    .finally(() => {
      codexRateLimitsRequest = null;
    });

  return await codexRateLimitsRequest;
}

export async function getClaudeRateLimits(sessionId: string): Promise<ClaudeRateLimits> {
  return await invoke<ClaudeRateLimits>("get_claude_rate_limits", { sessionId });
}

export async function setClaudeEffortSetting(
  level: ClaudeEffortInfo["effectiveLevel"],
  projectPath?: string | null
): Promise<ClaudeEffortInfo> {
  return await invoke("set_claude_effort_setting", {
    level,
    projectPath: projectPath ?? null,
  });
}

export async function getClaudeTheme(
  projectPath?: string | null
): Promise<ClaudeThemeInfo> {
  return await invoke("get_claude_theme", { projectPath: projectPath ?? null });
}

export async function setClaudeTheme(
  theme: string,
  projectPath?: string | null
): Promise<ClaudeThemeInfo> {
  return await invoke("set_claude_theme", {
    theme,
    projectPath: projectPath ?? null,
  });
}

export async function initializePersistentSettings(
  legacySettings?: PersistentSettings
): Promise<PersistentSettings> {
  return await invoke("initialize_persistent_settings", {
    legacySettings: legacySettings ?? null,
  });
}

export async function getPersistentSettings(): Promise<PersistentSettings> {
  return await invoke("get_persistent_settings");
}

export async function savePersistentSettings(settings: PersistentSettings): Promise<void> {
  await invoke("save_persistent_settings", { settings });
}

export async function setExplorerContextMenuEnabled(enabled: boolean): Promise<void> {
  await invoke("set_explorer_context_menu_enabled", { enabled });
}

export async function getSearchIndexStatus(
  projectPath: string
): Promise<ProjectSearchIndexStatus> {
  return await invoke("get_search_index_status", { projectPath });
}

export async function setProjectIndexEnabled(
  projectPath: string,
  enabled: boolean
): Promise<ProjectSearchIndexStatus> {
  return await invoke("set_project_index_enabled", { projectPath, enabled });
}

export async function rebuildProjectIndex(
  projectPath: string
): Promise<ProjectSearchIndexStatus> {
  return await invoke("rebuild_project_index", { projectPath });
}

export async function pauseProjectIndex(projectPath: string): Promise<ProjectSearchIndexStatus> {
  return await invoke("pause_project_index", { projectPath });
}

export async function resumeProjectIndex(projectPath: string): Promise<ProjectSearchIndexStatus> {
  return await invoke("resume_project_index", { projectPath });
}

export async function deleteProjectIndex(
  projectPath: string
): Promise<ProjectSearchIndexStatus> {
  return await invoke("delete_project_index", { projectPath });
}

export async function getSearchIndexStorageStatus(): Promise<SearchIndexStorageStatus> {
  return await invoke("get_search_index_storage_status");
}

export async function setSearchIndexStorage(
  cacheRoot: string | null,
  quotaBytes: number
): Promise<SearchIndexStorageStatus> {
  return await invoke("set_search_index_storage", { cacheRoot, quotaBytes });
}

export async function clearSearchIndexCache(): Promise<SearchIndexStorageStatus> {
  return await invoke("clear_search_index_cache");
}

export async function getClaudeMdDetail(
  scope: ClaudeMdScope,
  projectPath?: string | null
): Promise<ClaudeMdDetail> {
  return await invoke("get_claude_md_detail", {
    scope,
    projectPath: projectPath ?? null,
  });
}

export async function saveClaudeMd(
  scope: ClaudeMdScope,
  content: string,
  projectPath?: string | null
): Promise<ClaudeMdDetail> {
  return await invoke("save_claude_md", {
    scope,
    content,
    projectPath: projectPath ?? null,
  });
}

export async function ptyInput(sessionId: string, data: string): Promise<void> {
  await invoke("pty_input", { sessionId, data });
}

export async function markSessionPromptSubmitted(sessionId: string): Promise<void> {
  await invoke("mark_session_prompt_submitted", { sessionId });
}

export async function generateSessionTitle(prompt: string, path: string): Promise<string> {
  return await invoke("generate_session_title", { prompt, path });
}

export async function submitAgentTurnInput(
  sessionId: string,
  data: string,
): Promise<AgentTurnStartResult> {
  return await invoke("submit_agent_turn_input", { sessionId, data });
}

export async function completeAgentTurn(sessionId: string): Promise<AgentTurnReview | null> {
  return await invoke("complete_agent_turn", { sessionId });
}

export async function ptyResize(
  sessionId: string,
  rows: number,
  cols: number
): Promise<void> {
  await invoke("pty_resize", { sessionId, rows, cols });
}

export async function closePty(sessionId: string): Promise<void> {
  await invoke("close_pty", { sessionId });
}

export async function cleanupStaleSessions(): Promise<void> {
  await invoke("cleanup_stale_sessions");
}

export async function cleanupSessionProcess(sessionId: string): Promise<void> {
  await invoke("cleanup_session_process", { sessionId });
}

export async function isSessionActive(sessionId: string): Promise<boolean> {
  return await invoke("is_session_active", { sessionId });
}

export async function openInFileManager(path: string): Promise<void> {
  await invoke("open_in_explorer", { path });
}

function isWindowsNativePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function isProbablyUrl(value: string): boolean {
  if (isWindowsNativePath(value)) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol.length > 1;
  } catch {
    return false;
  }
}

export async function openInAssociatedApplication(path: string): Promise<void> {
  const target = path.trim();
  if (!target) {
    throw new Error("目标路径不能为空");
  }

  if (isProbablyUrl(target)) {
    await openUrl(target);
    return;
  }

  await invoke("open_in_associated_application", { path: target });
}

export async function readProjectImage(
  projectPath: string,
  path: string
): Promise<ProjectImagePayload> {
  return await invoke("read_project_image", { projectPath, path });
}

export async function readProjectPdf(projectPath: string, path: string): Promise<Uint8Array> {
  const response = await invoke<ArrayBuffer>("read_project_pdf", { projectPath, path });
  return new Uint8Array(response);
}

export async function listProjectDirectory(
  projectPath: string,
  directoryPath?: string | null
): Promise<FileTreeListing> {
  return await invoke("list_project_directory", {
    projectPath,
    directoryPath: directoryPath ?? null,
  });
}

export async function resolveProjectLink(
  projectPath: string,
  path: string
): Promise<ProjectLinkTarget> {
  return await invoke("resolve_project_link", { projectPath, path });
}

export async function searchProjectEntries(
  projectPath: string,
  query: string
): Promise<FileTreeEntry[]> {
  return await invoke("search_project_entries", {
    projectPath,
    query,
  });
}

export async function renameProjectEntry(
  projectPath: string,
  path: string,
  newName: string
): Promise<string> {
  return await invoke("rename_project_entry", {
    projectPath,
    path,
    newName,
  });
}

export async function deleteProjectEntry(projectPath: string, path: string): Promise<void> {
  await invoke("delete_project_entry", {
    projectPath,
    path,
  });
}

export async function createProjectFile(
  projectPath: string,
  parentPath: string,
  name: string
): Promise<string> {
  return await invoke("create_project_file", {
    projectPath,
    parentPath,
    name,
  });
}

export async function createProjectDirectory(
  projectPath: string,
  parentPath: string,
  name: string
): Promise<string> {
  return await invoke("create_project_directory", {
    projectPath,
    parentPath,
    name,
  });
}

export async function readProjectFile(
  projectPath: string,
  path: string
): Promise<ProjectFileContent> {
  return await invoke("read_project_file", {
    projectPath,
    path,
  });
}

export async function writeProjectFile(
  projectPath: string,
  path: string,
  content: string
): Promise<void> {
  await invoke("write_project_file", {
    projectPath,
    path,
    content,
  });
}

export async function inspectProjectFile(
  projectPath: string,
  path: string
): Promise<ProjectFileStatus> {
  return await invoke("inspect_project_file", {
    projectPath,
    path,
  });
}

export async function copyExternalEntry(
  projectPath: string,
  sourcePaths: string[],
  destinationDirectory: string,
  newName?: string | null
): Promise<string[]> {
  return await invoke("copy_external_entry", {
    projectPath,
    sourcePaths,
    destinationDirectory,
    newName: newName ?? null,
  });
}

export async function searchProjectText(
  request: ContentSearchRequest
): Promise<ContentSearchSummary> {
  return await invoke("search_project_text", { request });
}

export async function cancelContentSearch(searchId: string): Promise<void> {
  await invoke("cancel_content_search", { searchId });
}

export async function copyProjectEntries(
  projectPath: string,
  sourcePaths: string[],
  destinationDirectory: string
): Promise<string[]> {
  return await invoke("copy_project_entries", {
    projectPath,
    sourcePaths,
    destinationDirectory,
  });
}

// Skills API
export async function listSkills(projectPath?: string | null): Promise<SkillCatalog> {
  return await invoke("list_skills", { projectPath: projectPath ?? null });
}

export async function getSkillDetail(
  agent: SkillAgent,
  scope: SkillScope,
  folderName: string,
  enabled: boolean,
  projectPath?: string | null
): Promise<SkillDetail> {
  return await invoke("get_skill_detail", {
    agent,
    scope,
    folderName,
    enabled,
    projectPath: projectPath ?? null,
  });
}

export async function setSkillEnabled(
  agent: SkillAgent,
  scope: SkillScope,
  folderName: string,
  enabled: boolean,
  nextEnabled: boolean,
  projectPath?: string | null
): Promise<SkillInfo> {
  return await invoke("set_skill_enabled", {
    agent,
    scope,
    folderName,
    enabled,
    nextEnabled,
    projectPath: projectPath ?? null,
  });
}

export async function createSkill(
  agent: SkillAgent,
  scope: SkillScope,
  name: string,
  description?: string,
  projectPath?: string | null
): Promise<SkillInfo> {
  return await invoke("create_skill", {
    agent,
    scope,
    name,
    description: description ?? null,
    projectPath: projectPath ?? null,
  });
}

export async function ensureSkillDirectory(
  agent: SkillAgent,
  scope: SkillScope,
  enabled: boolean,
  projectPath?: string | null
): Promise<string> {
  return await invoke("ensure_skill_directory", {
    agent,
    scope,
    enabled,
    projectPath: projectPath ?? null,
  });
}

// Commands API
export async function listCommands(projectPath?: string | null): Promise<CommandCatalog> {
  return await invoke("list_commands", { projectPath: projectPath ?? null });
}

export async function getCommandDetail(
  scope: CommandScope,
  id: string,
  projectPath?: string | null
): Promise<CommandDetail> {
  return await invoke("get_command_detail", {
    scope,
    id,
    projectPath: projectPath ?? null,
  });
}

export async function createCommand(
  scope: CommandScope,
  draft: CommandDraft,
  projectPath?: string | null
): Promise<CommandInfo> {
  return await invoke("create_command", {
    scope,
    draft,
    projectPath: projectPath ?? null,
  });
}

export async function updateCommand(
  scope: CommandScope,
  id: string,
  draft: CommandDraft,
  projectPath?: string | null
): Promise<CommandInfo> {
  return await invoke("update_command", {
    scope,
    id,
    draft,
    projectPath: projectPath ?? null,
  });
}

export async function deleteCommand(
  scope: CommandScope,
  id: string,
  projectPath?: string | null
): Promise<void> {
  await invoke("delete_command", {
    scope,
    id,
    projectPath: projectPath ?? null,
  });
}

export async function ensureCommandStore(
  scope: CommandScope,
  projectPath?: string | null
): Promise<string> {
  return await invoke("ensure_command_store", {
    scope,
    projectPath: projectPath ?? null,
  });
}

export async function runCommandTest(
  scope: CommandScope,
  id: string,
  projectPath?: string | null
): Promise<CommandTestResult> {
  return await invoke("run_command_test", {
    scope,
    id,
    projectPath: projectPath ?? null,
  });
}

// Claude Config API
export interface HookStatus {
  configured: boolean;
  config_path: string;
  hook_command: string | null;
}

export async function checkClaudeHookStatus(): Promise<HookStatus> {
  return await invoke("check_claude_hook_status");
}

export async function configureClaudeHook(): Promise<HookStatus> {
  return await invoke("configure_claude_hook");
}

export async function listClaudeHooks(projectPath?: string | null): Promise<HookCatalog> {
  return await invoke("list_claude_hooks", { projectPath: projectPath ?? null });
}

export async function listAgentHooks(
  agent: HookAgent,
  projectPath?: string | null
): Promise<HookCatalog> {
  return await invoke("list_agent_hooks", { agent, projectPath: projectPath ?? null });
}

export async function getClaudeHookDetail(
  scope: HookScope,
  id: string,
  projectPath?: string | null
): Promise<HookDetail> {
  return await invoke("get_claude_hook_detail", {
    scope,
    id,
    projectPath: projectPath ?? null,
  });
}

export async function getAgentHookDetail(
  agent: HookAgent,
  scope: HookScope,
  id: string,
  projectPath?: string | null
): Promise<HookDetail> {
  return await invoke("get_agent_hook_detail", {
    agent,
    scope,
    id,
    projectPath: projectPath ?? null,
  });
}

export async function deleteClaudeHook(
  scope: HookScope,
  id: string,
  projectPath?: string | null
): Promise<void> {
  return await invoke("delete_claude_hook", {
    scope,
    id,
    projectPath: projectPath ?? null,
  });
}

export async function repairClaudeHooks(
  scope: HookScope,
  projectPath?: string | null
): Promise<HookCatalog> {
  return await invoke("repair_claude_hooks", {
    scope,
    projectPath: projectPath ?? null,
  });
}

export async function repairAgentHooks(
  agent: HookAgent,
  scope: HookScope,
  projectPath?: string | null
): Promise<HookCatalog> {
  return await invoke("repair_agent_hooks", {
    agent,
    scope,
    projectPath: projectPath ?? null,
  });
}

export async function migrateWorkspaceClaudeHooks(
  projectPath: string
): Promise<WorkspaceHookMigrationResult> {
  return await invoke("migrate_workspace_claude_hooks", { projectPath });
}

export interface HookIngestConfig {
  port: number;
  token: string;
}

export async function getHookIngestConfig(): Promise<HookIngestConfig> {
  return await invoke("get_hook_ingest_config");
}

export async function openProjectWindow(
  path: string,
  disposition: ProjectOpenDisposition = "auto"
): Promise<WindowProjectContext> {
  return await invoke("open_project_window", { path, disposition });
}

export async function focusExistingProjectWindow(path: string): Promise<boolean> {
  return await invoke("focus_existing_project_window", { path });
}

export async function getExistingProjectPaths(paths: string[]): Promise<string[]> {
  return await invoke("get_existing_project_paths", { paths });
}

export async function getWindowProjectContext(): Promise<WindowProjectContext> {
  return await invoke("get_window_project_context");
}

export async function releaseWindowProjectContext(): Promise<void> {
  await invoke("release_window_project_context");
}

export async function closeProjectSessions(projectPath: string): Promise<void> {
  await invoke("close_project_sessions", { projectPath });
}

export async function focusProjectWindow(
  projectPath: string,
  sessionId: string
): Promise<boolean> {
  return await invoke("focus_project_window", { projectPath, sessionId });
}

export async function ensureVoiceOverlayWindow(): Promise<void> {
  await invoke("ensure_voice_overlay_window");
}

export async function hideVoiceOverlayWindow(): Promise<void> {
  await invoke("hide_voice_overlay_window");
}

export async function sendSessionNotification(
  title: string,
  body: string,
  sessionId: string,
  projectPath: string
): Promise<void> {
  await invoke("send_session_notification", { title, body, sessionId, projectPath });
}
export interface FeishuCredentialStatus {
  configured: boolean;
  webhookHint: string | null;
  signingSecretConfigured: boolean;
  secureStorageAvailable: boolean;
}

export interface FeishuNotificationField {
  label: string;
  value: string;
}

export interface FeishuNotificationPayload {
  eventType: "completed" | "error" | "waiting" | "permission" | "test";
  title: string;
  fields: FeishuNotificationField[];
}

export interface FeishuSendResult {
  deliveredAt: number;
}

export async function getFeishuNotificationConfig(): Promise<FeishuCredentialStatus> {
  return await invoke("get_feishu_notification_config");
}

export async function saveFeishuNotificationCredentials(
  webhookUrl: string,
  signingSecret?: string | null
): Promise<FeishuCredentialStatus> {
  return await invoke("save_feishu_notification_credentials", {
    webhookUrl,
    signingSecret,
  });
}

export async function clearFeishuNotificationCredentials(): Promise<FeishuCredentialStatus> {
  return await invoke("clear_feishu_notification_credentials");
}

export async function sendFeishuNotification(
  payload: FeishuNotificationPayload
): Promise<FeishuSendResult> {
  return await invoke("send_feishu_notification", { payload });
}

export async function saveClipboardImage(
  dataBase64: string,
  mimeType: string
): Promise<SavedImagePayload> {
  return await invoke("save_clipboard_image", { dataBase64, mimeType });
}

export async function sendTextToFocusedWindow(text: string): Promise<void> {
  await invoke("send_text_to_focused_window", { text });
}

export async function configureVoiceGlobalShortcut(
  accelerator: string | null,
  enabled: boolean
): Promise<boolean> {
  return await invoke("configure_voice_global_shortcut", { accelerator, enabled });
}

export async function isVoiceGlobalShortcutRegistered(): Promise<boolean> {
  return await invoke("is_voice_global_shortcut_registered");
}

// Git API

export async function gitRepoInfo(projectPath: string): Promise<GitRepoInfo> {
  return await invoke("git_repo_info", { projectPath });
}

export async function gitStatus(projectPath: string): Promise<GitFileStatus[]> {
  return await invoke("git_status", { projectPath });
}

export async function gitBranchInfo(projectPath: string): Promise<GitBranchInfo> {
  return await invoke("git_branch_info", { projectPath });
}

export async function gitDiff(projectPath: string, filePath: string): Promise<GitDiffResult> {
  return await invoke("git_diff", { projectPath, filePath });
}

export async function gitDiffContent(
  projectPath: string,
  filePath: string,
  staged: boolean,
  oldFilePath?: string | null
): Promise<GitDiffContentResult> {
  return await invoke("git_diff_content", { projectPath, filePath, oldFilePath, staged });
}

export async function gitCommit(
  projectPath: string,
  message: string,
  files: string[]
): Promise<GitCommitResult> {
  return await invoke("git_commit", { projectPath, message, files });
}

export async function gitGenerateCommitMessage(
  projectPath: string,
  agentId: AiAgentId,
): Promise<string> {
  return await invoke("git_generate_commit_message", { projectPath, agentId });
}

export async function gitCloneRepository(options: {
  remoteUrl: string;
  parentDirectory: string;
  directoryName: string;
  branch?: string;
  shallow?: boolean;
}): Promise<GitCloneStartResult> {
  return await invoke("git_clone_repository", {
    remoteUrl: options.remoteUrl,
    parentDirectory: options.parentDirectory,
    directoryName: options.directoryName,
    branch: options.branch?.trim() || null,
    shallow: options.shallow ?? false,
  });
}

export async function gitCancelCloneTask(taskId: string): Promise<void> {
  await invoke("git_cancel_clone_task", { taskId });
}

export async function gitDiscardChanges(
  projectPath: string,
  files: string[]
): Promise<void> {
  await invoke("git_discard_changes", { projectPath, files });
}

export async function gitStageFiles(
  projectPath: string,
  files: string[]
): Promise<void> {
  await invoke("git_stage_files", { projectPath, files });
}

export async function gitUnstageFiles(
  projectPath: string,
  files: string[]
): Promise<void> {
  await invoke("git_unstage_files", { projectPath, files });
}

export async function gitCommitAmend(
  projectPath: string,
  message: string,
  files: string[]
): Promise<GitCommitResult> {
  return await invoke("git_commit_amend", { projectPath, message, files });
}

export async function gitPush(projectPath: string): Promise<GitRemoteResult> {
  return await invoke("git_push", { projectPath });
}

export async function gitAddRemoteAndPush(options: {
  projectPath: string;
  remoteName: string;
  remoteUrl: string;
  branchName: string;
}): Promise<GitRemoteResult> {
  return await invoke("git_add_remote_and_push", options);
}

export async function gitFetch(projectPath: string): Promise<GitRemoteResult> {
  return await invoke("git_fetch", { projectPath });
}

export async function gitPull(projectPath: string): Promise<GitRemoteResult> {
  return await invoke("git_pull", { projectPath });
}

export async function gitPullRebase(
  projectPath: string
): Promise<GitRemoteResult> {
  return await invoke("git_pull_rebase", { projectPath });
}

export async function gitGraphHistory(
  projectPath: string,
  limit?: number,
  cursor?: string
): Promise<GitGraphCommit[]> {
  return await invoke("git_graph_history", {
    projectPath,
    limit: limit ?? null,
    cursor: cursor ?? null,
  });
}

export async function gitGraphCommitDetail(
  projectPath: string,
  oid: string
): Promise<GitGraphCommitDetail> {
  return await invoke("git_graph_commit_detail", {
    projectPath,
    oid,
  });
}

export async function gitGraphFileDiff(
  projectPath: string,
  oid: string,
  filePath: string,
  oldFilePath?: string | null,
): Promise<GitDiffContentResult> {
  return await invoke("git_graph_file_diff", {
    projectPath,
    oid,
    filePath,
    oldFilePath: oldFilePath ?? null,
  });
}

export async function gitWatchStart(projectPath: string): Promise<void> {
  await invoke("git_watch_start", { projectPath });
}

export async function gitWatchStop(projectPath: string): Promise<void> {
  await invoke("git_watch_stop", { projectPath });
}

// Branch Management API

export async function gitListBranches(
  projectPath: string
): Promise<GitBranchListItem[]> {
  return await invoke("git_list_branches", { projectPath });
}

export async function gitCreateBranch(
  projectPath: string,
  name: string
): Promise<void> {
  await invoke("git_create_branch", { projectPath, name });
}

export async function gitSwitchBranch(
  projectPath: string,
  name: string
): Promise<void> {
  await invoke("git_switch_branch", { projectPath, name });
}

export async function gitDeleteBranch(
  projectPath: string,
  name: string,
  force?: boolean
): Promise<void> {
  await invoke("git_delete_branch", {
    projectPath,
    name,
    force: force ?? false,
  });
}

export async function gitMergeBranch(
  projectPath: string,
  branchName: string
): Promise<GitRemoteResult> {
  return await invoke("git_merge_branch", { projectPath, branchName });
}

// Hunk Staging API

export async function gitDiffHunks(
  projectPath: string,
  filePath: string,
  staged: boolean
): Promise<GitDiffHunkResult> {
  return await invoke("git_diff_hunks", { projectPath, filePath, staged });
}

export async function gitStageHunk(
  projectPath: string,
  filePath: string,
  hunkHeader: string
): Promise<void> {
  await invoke("git_stage_hunk", { projectPath, filePath, hunkHeader });
}

export async function gitUnstageHunk(
  projectPath: string,
  filePath: string,
  hunkHeader: string
): Promise<void> {
  await invoke("git_unstage_hunk", { projectPath, filePath, hunkHeader });
}

// Provider-independent Agent turn checkpoints

export async function checkpointListTurns(
  projectPath: string,
  sessionId?: string,
): Promise<AgentTurnReview[]> {
  return await invoke("checkpoint_list_turns", {
    projectPath,
    sessionId: sessionId ?? null,
  });
}

export async function checkpointFileDiff(
  projectPath: string,
  turnId: string,
  filePath: string,
): Promise<GitDiffContentResult> {
  return await invoke("checkpoint_file_diff", { projectPath, turnId, filePath });
}

export async function checkpointFileHunks(
  projectPath: string,
  turnId: string,
  filePath: string,
): Promise<GitDiffHunkResult> {
  return await invoke("checkpoint_file_hunks", { projectPath, turnId, filePath });
}

export async function checkpointSetFileDecision(
  projectPath: string,
  turnId: string,
  filePath: string,
  decision: CheckpointReviewDecision,
): Promise<AgentTurnReview> {
  return await invoke("checkpoint_set_file_decision", {
    projectPath,
    turnId,
    filePath,
    decision,
  });
}

export async function checkpointRejectFile(
  projectPath: string,
  turnId: string,
  filePath: string,
): Promise<CheckpointRestoreResult> {
  return await invoke("checkpoint_reject_file", { projectPath, turnId, filePath });
}

export async function checkpointSetHunkDecision(
  projectPath: string,
  turnId: string,
  filePath: string,
  hunkHeader: string,
  decision: CheckpointReviewDecision,
): Promise<CheckpointRestoreResult> {
  return await invoke("checkpoint_set_hunk_decision", {
    projectPath,
    turnId,
    filePath,
    hunkHeader,
    decision,
  });
}

export async function checkpointMarkReviewed(
  projectPath: string,
  turnId: string,
): Promise<AgentTurnReview> {
  return await invoke("checkpoint_mark_reviewed", { projectPath, turnId });
}

export async function checkpointRestoreTurn(
  projectPath: string,
  turnId: string,
): Promise<CheckpointRestoreResult> {
  return await invoke("checkpoint_restore_turn", { projectPath, turnId });
}

export async function checkpointDiscardTurn(
  projectPath: string,
  turnId: string,
): Promise<CheckpointRestoreResult> {
  return await invoke("checkpoint_discard_turn", { projectPath, turnId });
}

// Conflict Resolution API

export async function gitConflictDetail(
  projectPath: string,
  filePath: string
): Promise<GitConflictDetail> {
  return await invoke("git_conflict_detail", { projectPath, filePath });
}

export async function gitResolveConflict(
  projectPath: string,
  filePath: string,
  resolution: "ours" | "theirs" | "edited"
): Promise<void> {
  await invoke("git_resolve_conflict", { projectPath, filePath, resolution });
}

export async function gitAbortMerge(projectPath: string): Promise<void> {
  await invoke("git_abort_merge", { projectPath });
}

// MCP Server API

export async function listMcpServers(
  agent: AiAgentId,
  projectPath?: string | null
): Promise<McpServerCatalog> {
  return await invoke("list_mcp_servers", {
    agent,
    projectPath: projectPath ?? null,
  });
}

export async function addMcpServer(
  agent: AiAgentId,
  scope: string,
  name: string,
  config: McpServerConfig,
  projectPath?: string | null
): Promise<McpServerInfo> {
  return await invoke("add_mcp_server", {
    agent,
    scope,
    name,
    config,
    projectPath: projectPath ?? null,
  });
}

export async function updateMcpServer(
  agent: AiAgentId,
  scope: string,
  name: string,
  config: McpServerConfig,
  projectPath?: string | null
): Promise<McpServerInfo> {
  return await invoke("update_mcp_server", {
    agent,
    scope,
    name,
    config,
    projectPath: projectPath ?? null,
  });
}

export async function deleteMcpServer(
  agent: AiAgentId,
  scope: string,
  name: string,
  projectPath?: string | null
): Promise<void> {
  await invoke("delete_mcp_server", {
    agent,
    scope,
    name,
    projectPath: projectPath ?? null,
  });
}

export async function testMcpServer(
  agent: AiAgentId,
  scope: string,
  name: string,
  projectPath?: string | null
): Promise<McpServerTestResult> {
  return await invoke("test_mcp_server", {
    agent,
    scope,
    name,
    projectPath: projectPath ?? null,
  });
}
