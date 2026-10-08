import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Input, Segmented, Empty, Modal, Tag, Tooltip, message } from "antd";
import {
  PlusOutlined,
  SearchOutlined,
  DeleteOutlined,
  EditOutlined,
  CodeOutlined,
  RobotOutlined,
  GlobalOutlined,
  FolderOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/store";
import { useProjectQuickCommandsStore, persistQuickCommand, deletePersistedQuickCommand, refreshQuickCommandCatalog } from "@/store/slices/projectQuickCommands";
import { onQuickCommandsUpdated } from "@/lib/api";
import type { TerminalQuickCommand } from "@/types";
import {
  isQuickCommandComplete,
  createQuickCommandDraft,
} from "@/lib/quickCommands";
import { getAgentDisplayName } from "@/lib/agents";
import { AgentIcon } from "@/components/AgentIcon";
import { QuickCommandDialog } from "@/components/QuickCommandDialog";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";

type FilterMode = "all" | "global" | "repository";

export function QuickCommandsPage() {
  const { t } = useTranslation();
  const currentProject = useAppStore((s) => s.currentProject);
  const terminalQuickCommands = useProjectQuickCommandsStore((s) => s.catalog.commands);
  const catalogErrors = useProjectQuickCommandsStore((s) => s.catalog.errors);
  const catalogError = useProjectQuickCommandsStore((s) => s.catalogError);
  const catalogLoading = useProjectQuickCommandsStore((s) => s.catalogLoading);
  const recentProjects = useAppStore((s) => s.recentProjects);
  const projectPathsKey = useAppStore((s) => JSON.stringify([
    s.currentProject?.path,
    ...s.recentProjects.map((project) => project.path),
    ...Object.keys(s.projectSessions),
    ...Object.keys(s.projectArchivedSessions),
    ...Object.keys(s.projectWorkspaces),
  ]));
  const saving = useProjectQuickCommandsStore((s) => s.saving);

  const [filter, setFilter] = useState<FilterMode>("all");
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCommand, setEditingCommand] = useState<TerminalQuickCommand | null>(null);

  const repositoryId = currentProject?.path ?? null;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const reload = () => {
      if (!disposed) void refreshQuickCommandCatalog().catch(console.error);
    };
    const subscription = onQuickCommandsUpdated(reload);
    void subscription.then((stop) => {
      if (disposed) stop();
      else { unlisten = stop; reload(); }
    }).catch(() => reload());
    window.addEventListener("focus", reload);
    return () => {
      disposed = true;
      window.removeEventListener("focus", reload);
      unlisten?.();
    };
  }, [projectPathsKey]);

  const projectName = useCallback((path: string) => {
    return recentProjects.find((project) => project.path === path)?.name
      ?? path.split(/[\\/]/).filter(Boolean).pop()
      ?? path;
  }, [recentProjects]);

  // 过滤和搜索
  const filteredCommands = useMemo(() => {
    let result = terminalQuickCommands;

    // 作用域过滤
    if (filter === "global") {
      result = result.filter((c) => c.scope.type === "global");
    } else if (filter === "repository") {
      result = result.filter(
        (c) => c.scope.type === "repository" && c.scope.repositoryId === repositoryId,
      );
    }

    // 搜索
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      result = result.filter(
        (c) =>
          c.label.toLowerCase().includes(q) || c.command.toLowerCase().includes(q)
          || (c.scope.type === "repository" && (
            c.scope.repositoryId.toLowerCase().includes(q) || projectName(c.scope.repositoryId).toLowerCase().includes(q)
          )),
      );
    }

    return result;
  }, [terminalQuickCommands, filter, search, repositoryId, projectName]);

  // 统计
  const stats = useMemo(() => {
    const all = terminalQuickCommands.length;
    const global = terminalQuickCommands.filter((c) => c.scope.type === "global").length;
    const repo = terminalQuickCommands.filter(
      (c) => c.scope.type === "repository" && c.scope.repositoryId === repositoryId,
    ).length;
    return { all, global, repo };
  }, [terminalQuickCommands, repositoryId]);

  // 保存命令
  const saveCommand = useCallback(
    async (command: TerminalQuickCommand) => {
      try {
        await persistQuickCommand(command, editingCommand?.scope);
        message.success(t("quickCommands.saveSuccess"));
        setDialogOpen(false);
        setEditingCommand(null);
      } catch (error) {
        message.error(t("quickCommands.saveFailed", { error: String(error) }));
      }
    },
    [editingCommand, t],
  );

  // 删除命令
  const deleteCommand = useCallback(
    (command: TerminalQuickCommand) => {
      Modal.confirm({
        title: t("quickCommands.deleteConfirmTitle"),
        content: t("quickCommands.deleteConfirmContent", { label: command.label }),
        okText: t("common.confirm"),
        cancelText: t("common.cancel"),
        okButtonProps: { danger: true },
        async onOk() {
          try {
            await deletePersistedQuickCommand(command);
            message.success(t("quickCommands.deleteSuccess"));
          } catch (error) {
            message.error(t("quickCommands.deleteFailed", { error: String(error) }));
            throw error;
          }
        },
      });
    },
    [t],
  );

  // 新增
  const openAddDialog = useCallback(() => {
    // 草稿只在打开时创建，后台刷新目录时不重置正在填写的表单。
    setEditingCommand(createQuickCommandDraft(
      filter !== "global" && repositoryId
        ? { type: "repository", repositoryId }
        : { type: "global" },
    ));
    setDialogOpen(true);
  }, [filter, repositoryId]);

  // 编辑
  const openEditDialog = useCallback((command: TerminalQuickCommand) => {
    setEditingCommand(command);
    setDialogOpen(true);
  }, []);

  return (
    <div className="flex flex-col gap-4 h-full">
      <SettingsPageHeader
        title={t("quickCommands.settingsTitle")}
        actions={
          <Button
            type="primary"
            size="small"
            icon={<PlusOutlined />}
            onClick={openAddDialog}
          >
            {t("quickCommands.addCommand")}
          </Button>
        }
      >
        <div className="flex items-center gap-3 flex-wrap">
          <Segmented
            size="small"
            value={filter}
            onChange={(val) => setFilter(val as FilterMode)}
            options={[
              {
                label: `${t("quickCommands.filterAll")} (${stats.all})`,
                value: "all",
              },
              {
                label: `${t("quickCommands.currentProject")} (${stats.repo})`,
                value: "repository",
              },
              {
                label: `${t("quickCommands.scopeGlobal")} (${stats.global})`,
                value: "global",
              },
            ]}
          />
          <Input
            prefix={<SearchOutlined style={{ color: "var(--cs-text-tertiary)", fontSize: 12 }} />}
            placeholder={t("quickCommands.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            size="small"
            allowClear
            style={{ width: 200 }}
          />
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={catalogLoading}
            disabled={saving}
            onClick={() => void refreshQuickCommandCatalog().catch(console.error)}
          >
            {t("quickCommands.refresh")}
          </Button>
        </div>
      </SettingsPageHeader>

      {catalogError && <Alert type="error" showIcon message={t("quickCommands.loadFailed", { error: catalogError })} />}
      {catalogErrors.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={t("quickCommands.unavailableProjects", { count: catalogErrors.length })}
          description={<div className="whitespace-pre-wrap break-all">{catalogErrors.map((item) => `${item.projectPath}: ${item.error}`).join("\n")}</div>}
        />
      )}

      {/* 命令列表 */}
      <div className="flex-1 overflow-y-auto">
        {filteredCommands.length === 0 ? (
          <Empty
            description={
              search
                ? t("quickCommands.noCommands")
                : filter === "repository"
                  ? t("quickCommands.noProjectCommands")
                  : t("quickCommands.noCommands")
            }
            style={{ marginTop: 48 }}
          />
        ) : (
          <div className="flex flex-col gap-1">
            {filteredCommands.map((cmd) => (
              <div
                key={JSON.stringify([cmd.scope, cmd.id])}
                className="flex items-center gap-3 px-3 py-2 rounded transition-colors"
                style={{
                  background: "var(--cs-bg-card)",
                  border: "1px solid var(--cs-border-secondary)",
                }}
              >
                {cmd.action === "agent-prompt" ? (
                  cmd.agentId ? (
                    <AgentIcon agentId={cmd.agentId} size={16} />
                  ) : (
                    <RobotOutlined
                      style={{ fontSize: 14, color: "var(--cs-primary)", flexShrink: 0 }}
                    />
                  )
                ) : (
                  <CodeOutlined
                    style={{ fontSize: 14, color: "var(--cs-text-tertiary)", flexShrink: 0 }}
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className="text-xs font-medium truncate"
                      style={{ color: "var(--cs-text-primary)" }}
                    >
                      {cmd.label}
                    </span>
                    <Tag
                      color={cmd.action === "agent-prompt" ? "purple" : "default"}
                      style={{ fontSize: 10, lineHeight: "16px", padding: "0 4px", margin: 0 }}
                    >
                      {t(
                        cmd.action === "agent-prompt"
                          ? "quickCommands.actionAgent"
                          : "quickCommands.actionTerminal",
                      )}
                    </Tag>
                    <Tag
                      style={{ fontSize: 10, lineHeight: "16px", padding: "0 4px", margin: 0 }}
                      color={cmd.scope.type === "global" ? "blue" : "green"}
                    >
                      {cmd.scope.type === "global" ? (
                        <>
                          <GlobalOutlined style={{ marginRight: 2 }} />
                          {t("quickCommands.scopeGlobal")}
                        </>
                      ) : (
                        <>
                          <FolderOutlined style={{ marginRight: 2 }} />
                          <Tooltip title={cmd.scope.repositoryId}>
                            <span>{projectName(cmd.scope.repositoryId)}</span>
                          </Tooltip>
                        </>
                      )}
                    </Tag>
                    {!isQuickCommandComplete(cmd) && (
                      <Tag style={{ fontSize: 10, lineHeight: "16px", padding: "0 4px", margin: 0 }}>
                        {t("quickCommands.incomplete")}
                      </Tag>
                    )}
                  </div>
                  <div
                    className="text-xs truncate mt-0.5"
                    style={{ color: "var(--cs-text-tertiary)", fontFamily: "var(--font-mono)" }}
                  >
                    {cmd.action === "agent-prompt" && cmd.agentId
                      ? `${getAgentDisplayName(cmd.agentId)} · `
                      : ""}
                    {cmd.command}
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => openEditDialog(cmd)}
                  />
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => deleteCommand(cmd)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 对话框 */}
      <QuickCommandDialog
        saving={saving}
        open={dialogOpen}
        command={
          editingCommand ??
          createQuickCommandDraft(
            filter === "global"
              ? { type: "global" }
              : repositoryId
                ? { type: "repository", repositoryId }
                : { type: "global" },
          )
        }
        onSave={saveCommand}
        onCancel={() => {
          setDialogOpen(false);
          setEditingCommand(null);
        }}
        repositoryId={editingCommand?.scope.type === "repository" ? editingCommand.scope.repositoryId : repositoryId ?? ""}
      />
    </div>
  );
}
