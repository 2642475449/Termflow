import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Input, Empty, Modal, Spin, Tag, Tooltip, message } from "antd";
import {
  PlusOutlined,
  SearchOutlined,
  DeleteOutlined,
  EditOutlined,
  CodeOutlined,
  RobotOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/store";
import { useProjectQuickCommandsStore, persistQuickCommand, deletePersistedQuickCommand, loadProjectQuickCommands } from "@/store/slices/projectQuickCommands";
import type { TerminalQuickCommand } from "@/types";
import {
  isQuickCommandComplete,
  createQuickCommandDraft,
  quickCommandMatchesRepository,
} from "@/lib/quickCommands";
import { getAgentDisplayName } from "@/lib/agents";
import { AgentIcon } from "@/components/AgentIcon";
import { QuickCommandDialog } from "@/components/QuickCommandDialog";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";

export function QuickCommandsPage() {
  const { t } = useTranslation();
  const currentProject = useAppStore((s) => s.currentProject);
  const terminalQuickCommands = useAppStore((s) => s.terminalQuickCommands);
  const loadedProjectPath = useProjectQuickCommandsStore((s) => s.loadedProjectPath);
  const loadError = useProjectQuickCommandsStore((s) => s.error);
  const loading = useProjectQuickCommandsStore((s) => s.loading);
  const saving = useProjectQuickCommandsStore((s) => s.saving);

  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCommand, setEditingCommand] = useState<TerminalQuickCommand | null>(null);
  const [deletingCommand, setDeletingCommand] = useState<TerminalQuickCommand | null>(null);

  const repositoryId = currentProject?.path ?? null;
  const error = loadedProjectPath === repositoryId ? loadError : null;
  const projectLoading = repositoryId !== null && (loading || loadedProjectPath !== repositoryId);

  // 项目切换后立即隐藏旧编辑器，不能继续编辑原项目的命令。
  useEffect(() => {
    setSearch("");
    setDialogOpen(false);
    setEditingCommand(null);
    setDeletingCommand(null);
  }, [repositoryId]);

  // 过滤和搜索
  const filteredCommands = useMemo(() => {
    let result = terminalQuickCommands.filter((command) => quickCommandMatchesRepository(command, repositoryId));

    // 搜索
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      result = result.filter(
        (c) =>
          c.label.toLowerCase().includes(q) || c.command.toLowerCase().includes(q),
      );
    }

    return result;
  }, [terminalQuickCommands, search, repositoryId]);

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
  const deleteCommand = useCallback(async () => {
    if (!deletingCommand) return;
    try {
      await deletePersistedQuickCommand(deletingCommand);
      message.success(t("quickCommands.deleteSuccess"));
      setDeletingCommand(null);
    } catch (error) {
      message.error(t("quickCommands.deleteFailed", { error: String(error) }));
    }
  }, [deletingCommand, t]);

  // 新增
  const openAddDialog = useCallback(() => {
    if (!repositoryId) return;
    // 草稿只在打开时创建，后台刷新目录时不重置正在填写的表单。
    setEditingCommand(createQuickCommandDraft({ type: "repository", repositoryId }));
    setDialogOpen(true);
  }, [repositoryId]);

  // 编辑
  const openEditDialog = useCallback((command: TerminalQuickCommand) => {
    setEditingCommand(command);
    setDialogOpen(true);
  }, []);

  return (
    <div className="flex flex-col gap-4 h-full">
      <SettingsPageHeader
        title={t("quickCommands.settingsTitle")}
        description={t("quickCommands.settingsDescription")}
        actions={
          <Button
            type="primary"
            size="small"
            icon={<PlusOutlined />}
            onClick={openAddDialog}
            disabled={!repositoryId}
          >
            {t("quickCommands.addCommand")}
          </Button>
        }
      >
        <div className="flex items-center gap-3 flex-wrap">
          {currentProject && <Tooltip title={repositoryId}><span className="text-xs text-[var(--cs-text-secondary)]">
            {t("quickCommands.currentProject")}: {currentProject.name} ({filteredCommands.length})
          </span></Tooltip>}
          <Input
            prefix={<SearchOutlined className="text-xs text-[var(--cs-text-tertiary)]" />}
            placeholder={t("quickCommands.searchPlaceholder")}
            aria-label={t("quickCommands.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            size="small"
            allowClear
            className="w-52 max-w-full"
          />
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={projectLoading}
            disabled={saving || !repositoryId}
            onClick={() => void loadProjectQuickCommands(repositoryId).catch(console.error)}
          >
            {t("quickCommands.refresh")}
          </Button>
        </div>
      </SettingsPageHeader>

      {!repositoryId && <Alert type="info" showIcon title={t("quickCommands.selectProjectToAdd")} />}
      {error && <Alert type="error" showIcon title={t("quickCommands.loadFailed", { error })} />}

      {/* 命令列表 */}
      <div className="flex-1 overflow-y-auto" aria-busy={projectLoading}>
        {projectLoading && filteredCommands.length === 0 && <div className="flex justify-center py-12"><Spin /></div>}
        {repositoryId && !projectLoading && filteredCommands.length === 0 && !error && (
          <Empty
            description={
              search
                ? t("quickCommands.noCommands")
                : t("quickCommands.noProjectCommands")
            }
            className="mt-12"
          />
        )}
        {filteredCommands.length > 0 && (
          <div className="app-settings-list">
            {filteredCommands.map((cmd) => (
              <div
                key={JSON.stringify([cmd.scope, cmd.id])}
                className="app-settings-resource-row"
              >
                {cmd.action === "agent-prompt" ? (
                  cmd.agentId ? (
                    <AgentIcon agentId={cmd.agentId} size={16} />
                  ) : (
                    <RobotOutlined className="shrink-0 text-sm text-[var(--cs-primary)]" />
                  )
                ) : (
                  <CodeOutlined className="shrink-0 text-sm text-[var(--cs-text-tertiary)]" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className="text-xs font-medium truncate text-[var(--cs-text-primary)]"
                    >
                      {cmd.label}
                    </span>
                    <Tag
                      color={cmd.action === "agent-prompt" ? "purple" : "default"}
                      className="m-0! !px-1 !text-[11px] !leading-4"
                    >
                      {t(
                        cmd.action === "agent-prompt"
                          ? "quickCommands.actionAgent"
                          : "quickCommands.actionTerminal",
                      )}
                    </Tag>
                    {!isQuickCommandComplete(cmd) && (
                      <Tag className="m-0! !px-1 !text-[11px] !leading-4">
                        {t("quickCommands.incomplete")}
                      </Tag>
                    )}
                  </div>
                  <div
                    className="text-xs truncate mt-0.5 font-mono text-[var(--cs-text-tertiary)]"
                  >
                    {cmd.action === "agent-prompt" && cmd.agentId
                      ? `${getAgentDisplayName(cmd.agentId)} · `
                      : ""}
                    {cmd.command}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined />}
                    aria-label={`${t("common.edit")} ${cmd.label}`}
                    onClick={() => openEditDialog(cmd)}
                  />
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label={`${t("common.delete")} ${cmd.label}`}
                    onClick={() => setDeletingCommand(cmd)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 对话框 */}
      <Modal
        open={!!deletingCommand && quickCommandMatchesRepository(deletingCommand, repositoryId)}
        title={t("quickCommands.deleteConfirmTitle")}
        onOk={() => void deleteCommand()}
        onCancel={() => !saving && setDeletingCommand(null)}
        confirmLoading={saving}
        closable={!saving}
        mask={{ closable: !saving }}
        keyboard={!saving}
        okText={t("common.confirm")}
        cancelText={t("common.cancel")}
        okButtonProps={{ danger: true }}
      >
        {deletingCommand && quickCommandMatchesRepository(deletingCommand, repositoryId)
          ? t("quickCommands.deleteConfirmContent", { label: deletingCommand.label }) : null}
      </Modal>
      {editingCommand && quickCommandMatchesRepository(editingCommand, repositoryId) && (
        <QuickCommandDialog
          saving={saving}
          open={dialogOpen}
          command={editingCommand}
          onSave={saveCommand}
          onCancel={() => {
            setDialogOpen(false);
            setEditingCommand(null);
          }}
          repositoryId={editingCommand.scope.repositoryId}
        />
      )}
    </div>
  );
}
