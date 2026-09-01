import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FolderOpenOutlined,
  ReloadOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import { Button, Empty, Modal, Segmented, Select, Tag, message } from "antd";
import { useTranslation } from "react-i18next";
import {
  createProjectFile,
  getClaudeMdDetail,
  openInAssociatedApplication,
  openInFileManager,
  readProjectFile,
  saveClaudeMd,
  writeProjectFile,
} from "@/lib/api";
import { AgentIcon } from "@/components/AgentIcon";
import MonacoTextEditor from "@/components/editors/MonacoTextEditor";
import MarkdownPreview from "@/components/markdown/MarkdownPreview";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import { useAppStore } from "@/store";
import type { AiAgentId, ClaudeMdDetail, ClaudeMdScope } from "@/types";

type InstructionAgentId = AiAgentId;

type InstructionTarget = {
  scope: "user" | "workspace" | "local";
  label: string;
  path: string;
  relativePath?: string;
  status: "editable" | "planned";
  note: string;
};

type InstructionAgentConfig = {
  id: InstructionAgentId;
  name: string;
  accent: string;
  summary: string;
  targets: InstructionTarget[];
};

type ScopeState = {
  detail: ClaudeMdDetail | null;
  draft: string;
  loading: boolean;
  saving: boolean;
  loaded: boolean;
};

type ProjectInstructionState = {
  filePath: string;
  relativePath: string;
  exists: boolean;
  content: string;
  draft: string;
  loading: boolean;
  saving: boolean;
  loaded: boolean;
  updatedAt?: number | null;
};

function createEmptyScopeState(): ScopeState {
  return {
    detail: null,
    draft: "",
    loading: false,
    saving: false,
    loaded: false,
  };
}

function createEmptyProjectInstructionState(): ProjectInstructionState {
  return {
    filePath: "",
    relativePath: "",
    exists: false,
    content: "",
    draft: "",
    loading: false,
    saving: false,
    loaded: false,
    updatedAt: null,
  };
}

type MarkdownViewMode = "edit" | "preview";

function projectFile(projectPath: string | null, filePath: string) {
  return projectPath ? `${projectPath}\\${filePath}` : filePath;
}

function projectInstructionKey(projectPath: string, relativePath: string) {
  return `${projectPath}\u0000${relativePath.replace(/\\/g, "/")}`;
}

function splitRelativePath(relativePath: string) {
  const normalized = relativePath.replace(/\//g, "\\");
  const parts = normalized.split("\\").filter(Boolean);
  const name = parts.pop() ?? normalized;
  return {
    parentPath: parts.join("\\"),
    name,
  };
}

function resolveProjectParentPath(projectPath: string, parentPath: string) {
  return parentPath ? `${projectPath}\\${parentPath}` : projectPath;
}

function fileName(filePath: string) {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function buildInstructionAgents(
  projectPath: string | null,
  t: (key: string) => string,
): InstructionAgentConfig[] {
  return [
    {
      id: "claude",
      name: "Claude Code",
      accent: "#d97757",
      summary: "实现、重构和 Claude Code 原生工作流的独立指令文件。",
      targets: [
        {
          scope: "user",
          label: "全局",
          path: "~/.claude/CLAUDE.md",
          status: "editable",
          note: "影响所有 Claude Code 会话。",
        },
        {
          scope: "workspace",
          label: "项目",
          path: projectFile(projectPath, "CLAUDE.md"),
          status: "editable",
          note: "当前项目的 Claude Code 指令。",
        },
        {
          scope: "local",
          label: "本地",
          path: projectFile(projectPath, "CLAUDE.local.md"),
          status: "editable",
          note: "只在当前机器生效，适合个人偏好。",
        },
      ],
    },
    {
      id: "codex",
      name: "Codex",
      accent: "#4f6cf7",
      summary: "审查、验证、跨文件修改边界和 Codex 协作偏好的独立入口。",
      targets: [
        {
          scope: "workspace",
          label: "项目",
          path: projectFile(projectPath, "AGENTS.md"),
          relativePath: "AGENTS.md",
          status: "editable",
          note: "Codex 项目指令文件，内容不与 CLAUDE.md 同步。",
        },
        {
          scope: "local",
          label: "本地",
          path: projectFile(projectPath, ".codex\\instructions.md"),
          status: "planned",
          note: "可用于后续承载本机 Codex 偏好。",
        },
      ],
    },
    {
      id: "antigravity",
      name: "Antigravity CLI",
      accent: "#0f9d8a",
      summary: "长上下文阅读、资料整理和文档侧重点的独立配置位。",
      targets: [
        {
          scope: "workspace",
          label: "项目",
          path: projectFile(projectPath, "AGENTS.md"),
          relativePath: "AGENTS.md",
          status: "editable",
          note: "Antigravity CLI 原生读取的开放标准项目指令文件。",
        },
        {
          scope: "local",
          label: "兼容",
          path: projectFile(projectPath, "GEMINI.md"),
          relativePath: "GEMINI.md",
          status: "editable",
          note: "Antigravity CLI 仍原生兼容 GEMINI.md；保留此入口用于已有项目迁移。",
        },
      ],
    },
    {
      id: "opencode",
      name: "OpenCode",
      accent: "#7c3aed",
      summary: "OpenCode 工作流和模型偏好的独立说明文件。",
      targets: [
        {
          scope: "workspace",
          label: "项目",
          path: projectFile(projectPath, "AGENTS.md"),
          relativePath: "AGENTS.md",
          status: "editable",
          note: "可复用标准 AGENTS.md 名称，但由用户决定内容侧重点。",
        },
      ],
    },
    {
      id: "qoder",
      name: "Qoder CLI",
      accent: "#2adb5c",
      summary: "Qoder CLI 原生读取 AGENTS.md；此处独立维护当前项目的智能体指令。",
      targets: [
        {
          scope: "workspace",
          label: "项目",
          path: projectFile(projectPath, "AGENTS.md"),
          relativePath: "AGENTS.md",
          status: "editable",
          note: "Qoder CLI 在当前项目中原生读取的 AGENTS.md。",
        },
        {
          scope: "local",
          label: "本地",
          path: projectFile(projectPath, "AGENTS.local.md"),
          status: "planned",
          note: "Qoder CLI 支持 AGENTS.local.md；Termflow 的本地层编辑入口将在后续版本开放。",
        },
        {
          scope: "user",
          label: "全局",
          path: "~/.qoder/AGENTS.md",
          status: "planned",
          note: "Qoder CLI 的用户级指令文件；Termflow 暂不在此页面修改用户目录。",
        },
      ],
    },
    {
      id: "pi",
      name: "Pi",
      accent: "#71717a",
      summary: t("settings.claudeMd.piSummary"),
      targets: [
        {
          scope: "workspace",
          label: t("settings.claudeMd.piWorkspaceLabel"),
          path: projectFile(projectPath, "AGENTS.md"),
          relativePath: "AGENTS.md",
          status: "editable",
          note: t("settings.claudeMd.piWorkspaceNote"),
        },
        {
          scope: "user",
          label: t("settings.claudeMd.piUserLabel"),
          path: "~/.pi/agent/AGENTS.md",
          status: "planned",
          note: t("settings.claudeMd.piUserNote"),
        },
      ],
    },
  ];
}

export function ClaudeMdPage() {
  const { t } = useTranslation();
  const currentProject = useAppStore((s) => s.currentProject);
  const projectPath = currentProject?.path ?? null;
  const instructionAgents = useMemo(() => buildInstructionAgents(projectPath, t), [projectPath, t]);
  const [activeAgent, setActiveAgent] = useState<InstructionAgentId>("claude");
  const [activeScope, setActiveScope] = useState<ClaudeMdScope>(projectPath ? "workspace" : "user");
  const [documents, setDocuments] = useState<Record<ClaudeMdScope, ScopeState>>({
    user: createEmptyScopeState(),
    workspace: createEmptyScopeState(),
    local: createEmptyScopeState(),
  });
  const [projectInstructions, setProjectInstructions] = useState<Record<string, ProjectInstructionState>>({});
  const [viewMode, setViewMode] = useState<MarkdownViewMode>("edit");
  const activeAgentConfig = instructionAgents.find((agent) => agent.id === activeAgent) ?? instructionAgents[0];
  const isClaudeActive = activeAgent === "claude";
  const activeProjectTarget = activeAgentConfig.targets.find((target) => target.status === "editable" && target.relativePath);
  const activeProjectKey = projectPath && activeProjectTarget?.relativePath
    ? projectInstructionKey(projectPath, activeProjectTarget.relativePath)
    : "";
  const activeProjectState = projectInstructions[activeProjectKey] ?? createEmptyProjectInstructionState();

  const currentState = documents[activeScope];
  const currentDetail = currentState.detail;
  const currentDraft = currentState.draft;
  const currentExists = currentDetail?.exists ?? false;
  const currentDirty = currentDraft !== (currentDetail?.content ?? "");
  const activeDraft = isClaudeActive ? currentDraft : activeProjectState.draft;
  const activeFilePath = isClaudeActive
    ? currentDetail?.filePath ?? "CLAUDE.md"
    : activeProjectState.filePath || activeProjectTarget?.path || activeAgentConfig.name;
  const activeDirty = isClaudeActive
    ? currentDirty
    : activeProjectState.draft !== activeProjectState.content;
  const activeLoading = isClaudeActive ? currentState.loading : activeProjectState.loading;
  const activeSaving = isClaudeActive ? currentState.saving : activeProjectState.saving;
  const canSave = isClaudeActive
    ? currentState.loaded && currentDirty
    : Boolean(projectPath && activeProjectTarget?.relativePath && activeProjectState.loaded && activeDirty);

  const sourceLabel = useMemo(() => {
    switch (currentDetail?.source) {
      case "workspace-dot-claude":
        return t("settings.claudeMd.source.workspaceDotClaude");
      case "workspace-root":
        return t("settings.claudeMd.source.workspaceRoot");
      case "local":
        return t("settings.claudeMd.source.local");
      case "user":
      default:
        return t("settings.claudeMd.source.user");
    }
  }, [currentDetail?.source, t]);

  const loadScope = useCallback(async (scope: ClaudeMdScope, force = false) => {
    if ((scope === "workspace" || scope === "local") && !projectPath) {
      return;
    }

    const existing = documents[scope];
    if (!force && (existing.loading || existing.loaded)) {
      return;
    }

    setDocuments((prev) => ({
      ...prev,
      [scope]: {
        ...prev[scope],
        loading: true,
      },
    }));

    try {
      const detail = await getClaudeMdDetail(scope, projectPath);
      setDocuments((prev) => ({
        ...prev,
        [scope]: {
          detail,
          draft: detail.content,
          loading: false,
          saving: false,
          loaded: true,
        },
      }));
    } catch (error) {
      console.error("Failed to load CLAUDE.md:", error);
      message.error(t("settings.claudeMd.loadFailed"));
      setDocuments((prev) => ({
        ...prev,
        [scope]: {
          ...prev[scope],
          loading: false,
        },
      }));
    }
  }, [activeScope, documents, projectPath, t]);

  const loadProjectInstruction = useCallback(async (
    target: InstructionTarget | undefined,
    force = false
  ) => {
    if (!target?.relativePath || !projectPath) {
      return;
    }

    const key = projectInstructionKey(projectPath, target.relativePath);
    const existing = projectInstructions[key];
    if (!force && existing?.loaded && existing.relativePath === target.relativePath) {
      return;
    }
    if (!force && existing?.loading) {
      return;
    }

    setProjectInstructions((prev) => ({
      ...prev,
      [key]: {
        ...(prev[key] ?? createEmptyProjectInstructionState()),
        filePath: target.path,
        relativePath: target.relativePath!,
        loading: true,
      },
    }));

    try {
      const file = await readProjectFile(projectPath, target.relativePath);
      setProjectInstructions((prev) => ({
        ...prev,
        [key]: {
          filePath: file.path,
          relativePath: target.relativePath!,
          exists: true,
          content: file.content,
          draft: file.content,
          loading: false,
          saving: false,
          loaded: true,
          updatedAt: file.modifiedAtMs,
        },
      }));
    } catch (error) {
      setProjectInstructions((prev) => ({
        ...prev,
        [key]: {
          filePath: target.path,
          relativePath: target.relativePath!,
          exists: false,
          content: "",
          draft: "",
          loading: false,
          saving: false,
          loaded: true,
          updatedAt: null,
        },
      }));
    }
  }, [projectInstructions, projectPath]);

  useEffect(() => {
    if (!projectPath && activeScope !== "user") {
      setActiveScope("user");
    }
  }, [activeScope, projectPath]);

  useEffect(() => {
    if (isClaudeActive) {
      void loadScope(activeScope);
    }
  }, [activeScope, isClaudeActive, loadScope]);

  useEffect(() => {
    if (!isClaudeActive) {
      void loadProjectInstruction(activeProjectTarget);
    }
  }, [activeProjectTarget, isClaudeActive, loadProjectInstruction]);

  function handleDraftChange(value: string) {
    if (isClaudeActive) {
      setDocuments((prev) => ({
        ...prev,
        [activeScope]: {
          ...prev[activeScope],
          draft: value,
        },
      }));
      return;
    }

    setProjectInstructions((prev) => ({
      ...prev,
      [activeProjectKey]: {
        ...(prev[activeProjectKey] ?? createEmptyProjectInstructionState()),
        draft: value,
      },
    }));
  }

  function handleScopeChange(scope: ClaudeMdScope) {
    setActiveScope(scope);
  }

  async function handleSave() {
    if (!isClaudeActive) {
      if (!projectPath || !activeProjectTarget?.relativePath) {
        return;
      }

      setProjectInstructions((prev) => ({
        ...prev,
        [activeProjectKey]: {
          ...(prev[activeProjectKey] ?? createEmptyProjectInstructionState()),
          saving: true,
        },
      }));

      try {
        if (!activeProjectState.exists) {
          const { parentPath, name } = splitRelativePath(activeProjectTarget.relativePath);
          await createProjectFile(projectPath, resolveProjectParentPath(projectPath, parentPath), name);
        }
        await writeProjectFile(projectPath, activeProjectTarget.relativePath, activeProjectState.draft);
        await loadProjectInstruction(activeProjectTarget, true);
        message.success(`${activeAgentConfig.name} 指令文件已保存`);
      } catch (error) {
        console.error("Failed to save agent instruction file:", error);
        message.error(`保存 ${activeAgentConfig.name} 指令文件失败`);
        setProjectInstructions((prev) => ({
          ...prev,
          [activeProjectKey]: {
            ...(prev[activeProjectKey] ?? createEmptyProjectInstructionState()),
            saving: false,
          },
        }));
      }
      return;
    }

    if (!currentDetail && !currentState.loaded) {
      await loadScope(activeScope, true);
      return;
    }

    setDocuments((prev) => ({
      ...prev,
      [activeScope]: {
        ...prev[activeScope],
        saving: true,
      },
    }));

    try {
      const detail = await saveClaudeMd(activeScope, currentDraft, projectPath);
      setDocuments((prev) => ({
        ...prev,
        [activeScope]: {
          detail,
          draft: detail.content,
          loading: false,
          saving: false,
          loaded: true,
        },
      }));
      message.success(t("settings.claudeMd.saveSuccess"));
    } catch (error) {
      console.error("Failed to save CLAUDE.md:", error);
      message.error(t("settings.claudeMd.saveFailed"));
      setDocuments((prev) => ({
        ...prev,
        [activeScope]: {
          ...prev[activeScope],
          saving: false,
        },
      }));
    }
  }

  function handleRefresh() {
    if (!isClaudeActive) {
      if (!activeProjectTarget) return;
      if (activeDirty) {
        Modal.confirm({
          title: t("settings.claudeMd.confirmRefreshTitle"),
          content: t("settings.claudeMd.confirmRefreshDesc"),
          okText: t("common.refresh"),
          cancelText: t("common.cancel"),
          onOk: async () => {
            await loadProjectInstruction(activeProjectTarget, true);
          },
        });
        return;
      }
      void loadProjectInstruction(activeProjectTarget, true);
      return;
    }

    if (currentDirty) {
      Modal.confirm({
        title: t("settings.claudeMd.confirmRefreshTitle"),
        content: t("settings.claudeMd.confirmRefreshDesc"),
        okText: t("common.refresh"),
        cancelText: t("common.cancel"),
        onOk: async () => {
          await loadScope(activeScope, true);
        },
      });
      return;
    }
    void loadScope(activeScope, true);
  }

  async function handleOpenLocation() {
    if (!isClaudeActive) {
      if (!projectPath) return;
      try {
        await openInFileManager(projectPath);
      } catch (error) {
        console.error("Failed to open instruction location:", error);
        message.error(t("settings.claudeMd.openFailed"));
      }
      return;
    }
    if (!currentDetail) return;
    try {
      await openInFileManager(currentDetail.exists ? currentDetail.filePath : currentDetail.directoryPath);
    } catch (error) {
      console.error("Failed to open CLAUDE.md location:", error);
      message.error(t("settings.claudeMd.openFailed"));
    }
  }

  return (
    <>
      <SettingsPageHeader
        title={t("settings.claudeMd.title")}
        description={t("settings.claudeMd.headerDesc")}
        actions={
          <>
            <Button
              icon={<ReloadOutlined spin={activeLoading} />}
              onClick={handleRefresh}
              disabled={activeLoading || (!isClaudeActive && !activeProjectTarget)}
            >
              {t("common.refresh")}
            </Button>
            <Button
              icon={<FolderOpenOutlined />}
              onClick={handleOpenLocation}
              disabled={isClaudeActive ? !currentDetail : !projectPath}
            >
              {t("settings.claudeMd.openLocation")}
            </Button>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              onClick={() => void handleSave()}
              loading={activeSaving}
              disabled={!canSave}
            >
              {t("settings.claudeMd.save")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex shrink-0 items-center gap-3">
            <span className="text-xs font-medium" style={{ color: "var(--cs-text-tertiary)" }}>
              {t("settings.claudeMd.agentLabel")}
            </span>
            <Select<InstructionAgentId>
              value={activeAgent}
              onChange={setActiveAgent}
              style={{ width: 220 }}
              options={instructionAgents.map((agent) => ({
                value: agent.id,
                label: (
                  <span className="inline-flex items-center gap-2">
                    <AgentIcon agentId={agent.id} size={16} />
                    <span>{agent.name}</span>
                  </span>
                ),
              }))}
              optionLabelProp="label"
            />
          </div>
          <div
            className="hidden h-5 w-px lg:block"
            style={{ background: "var(--cs-border-card)" }}
          />
          <div className="min-w-0 flex-1 truncate text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
            {activeAgentConfig.summary}
          </div>
        </div>

        <div
          className="mt-3 flex flex-col gap-3 pt-3 lg:flex-row lg:items-center lg:justify-between"
          style={{
            borderTop: "1px solid var(--cs-border-card)",
          }}
        >
          <div className="min-w-0 overflow-x-auto">
            {isClaudeActive ? (
              <Segmented
                value={activeScope}
                onChange={(value) => handleScopeChange(value as ClaudeMdScope)}
                options={[
                  { label: t("settings.claudeMd.scope.user"), value: "user" },
                  { label: t("settings.claudeMd.scope.workspace"), value: "workspace", disabled: !projectPath },
                  { label: t("settings.claudeMd.scope.local"), value: "local", disabled: !projectPath },
                ]}
              />
            ) : (
              <Segmented
                value={activeProjectTarget?.scope}
                options={activeAgentConfig.targets.map((target) => ({
                  value: target.scope,
                  label: `${target.label} · ${fileName(target.path)}`,
                  disabled: target.status !== "editable" || (target.scope !== "user" && !projectPath),
                  title: target.note,
                }))}
              />
            )}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-end">
            <Tag color={(isClaudeActive ? currentExists : activeProjectState.exists) ? "green" : "default"} className="!m-0">
              {(isClaudeActive ? currentExists : activeProjectState.exists)
                ? t("settings.claudeMd.fileExists")
                : t("settings.claudeMd.fileMissing")}
            </Tag>
            {isClaudeActive ? <Tag className="!m-0">{sourceLabel}</Tag> : null}
            <span
              className="max-w-[520px] truncate font-mono text-xs"
              title={activeFilePath}
              style={{ color: "var(--cs-text-tertiary)" }}
            >
              {activeFilePath}
            </span>
            {activeDirty ? (
              <span className="text-xs font-medium" style={{ color: "var(--cs-primary)" }}>
                {t("settings.claudeMd.unsaved")}
              </span>
            ) : null}
          </div>
        </div>
      </SettingsPageHeader>

      {!isClaudeActive && activeLoading ? (
        <div className="flex justify-center py-20">
          <ReloadOutlined spin style={{ fontSize: 18, color: "var(--cs-primary)" }} />
        </div>
      ) : !isClaudeActive && !activeProjectTarget ? (
        <div
          className="app-glass-card overflow-hidden rounded-lg"
          style={{
            background: "var(--cs-bg-card)",
            border: "1px solid var(--cs-border-card)",
            boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
          }}
        >
          <div
            className="flex items-center justify-between gap-3 px-4 py-3"
            style={{ borderBottom: "1px solid var(--cs-border-card)" }}
          >
            <div className="flex min-w-0 items-center gap-2">
              <AgentIcon agentId={activeAgentConfig.id} size={16} />
              <span className="truncate text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>
                {activeAgentConfig.name} 独立指令
              </span>
              <Tag color="default" className="!m-0">设计预览</Tag>
            </div>
          </div>
          <div className="px-5 py-12">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <div className="mx-auto max-w-xl text-center">
                  <div className="text-sm" style={{ color: "var(--cs-text-secondary)" }}>
                    {activeAgentConfig.name} 的规则文件不会从 CLAUDE.md 同步。
                  </div>
                  <div className="mt-2 text-xs leading-6" style={{ color: "var(--cs-text-tertiary)" }}>
                    下一步可以为这个智能体单独接入读取、创建和编辑能力；用户也可以从其他指令复制一次作为初始化，但之后保持独立维护。
                  </div>
                </div>
              }
            />
          </div>
        </div>
      ) : !currentState.loaded && currentState.loading ? (
        <div className="flex justify-center py-20">
          <ReloadOutlined spin style={{ fontSize: 18, color: "var(--cs-primary)" }} />
        </div>
      ) : (
        <>
          <div
            className="app-glass-card overflow-hidden rounded-lg"
            style={{
              background: "var(--cs-bg-card)",
              border: "1px solid var(--cs-border-card)",
              boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            }}
          >
            <div
              className="flex items-center justify-between gap-3 px-4 py-3"
              style={{ borderBottom: "1px solid var(--cs-border-card)" }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <AgentIcon agentId={activeAgentConfig.id} size={16} />
                <span className="text-sm font-medium truncate" style={{ color: "var(--cs-text-primary)" }}>
                  {fileName(activeFilePath)}
                </span>
                <span className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
                  {activeDirty ? "正在编辑" : "已保存"}
                </span>
              </div>
              <Segmented<MarkdownViewMode>
                size="small"
                value={viewMode}
                onChange={(value) => setViewMode(value)}
                options={[
                  {
                    value: "edit",
                    label: t("fileTabs.markdownModeEdit"),
                  },
                  {
                    value: "preview",
                    label: t("fileTabs.markdownModePreview"),
                  },
                ]}
              />
            </div>

            <div
              className="min-h-0 flex"
              style={{ height: "clamp(520px, calc(100vh - 390px), 760px)" }}
            >
              {viewMode === "preview" ? (
                <div className="app-markdown-preview-shell h-full w-full overflow-auto p-5">
                  <MarkdownPreview
                    content={activeDraft}
                    emptyText={t("fileTabs.markdownPreviewEmpty")}
                    filePath={activeFilePath}
                    projectPath={projectPath ?? undefined}
                    className="app-markdown-preview-surface"
                    onOpenExternalLink={(href) => {
                      void openInAssociatedApplication(href);
                    }}
                  />
                </div>
              ) : (
                <div className="h-full w-full flex flex-col min-h-0">
                  <MonacoTextEditor
                    key={`${activeAgent}-${activeScope}-${activeFilePath}-edit`}
                    filePath={activeFilePath}
                    value={activeDraft}
                    readOnly={false}
                    onChange={handleDraftChange}
                    onSave={() => {
                      void handleSave();
                    }}
                    saveEnabled={canSave && !activeSaving}
                  />
                </div>
              )}
            </div>
          </div>

          {!projectPath && (activeScope === "workspace" || activeScope === "local") ? (
            <Empty description={t("settings.claudeMd.openProjectFirst")} style={{ padding: "36px 0" }} />
          ) : null}
        </>
      )}
    </>
  );
}

export default ClaudeMdPage;
