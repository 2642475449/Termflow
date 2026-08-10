import { useCallback, useMemo, useState } from "react";
import { Button, Input, Segmented, Empty, Modal, Tag, message } from "antd";
import {
  PlusOutlined,
  SearchOutlined,
  DeleteOutlined,
  EditOutlined,
  CodeOutlined,
  RobotOutlined,
  GlobalOutlined,
  FolderOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/store";
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
  const terminalQuickCommands = useAppStore((s) => s.terminalQuickCommands);
  const setTerminalQuickCommands = useAppStore((s) => s.setTerminalQuickCommands);
  const removeTerminalQuickCommand = useAppStore((s) => s.removeTerminalQuickCommand);

  const [filter, setFilter] = useState<FilterMode>("all");
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCommand, setEditingCommand] = useState<TerminalQuickCommand | null>(null);

  const repositoryId = currentProject?.path ?? null;

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
          c.label.toLowerCase().includes(q) || c.command.toLowerCase().includes(q),
      );
    }

    return result;
  }, [terminalQuickCommands, filter, search, repositoryId]);

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
    (command: TerminalQuickCommand) => {
      const existing = terminalQuickCommands.findIndex((c) => c.id === command.id);
      let updated: TerminalQuickCommand[];
      if (existing >= 0) {
        updated = [...terminalQuickCommands];
        updated[existing] = command;
      } else {
        updated = [...terminalQuickCommands, command];
      }
      setTerminalQuickCommands(updated);
      message.success(t("quickCommands.saveSuccess"));
      setDialogOpen(false);
      setEditingCommand(null);
    },
    [terminalQuickCommands, setTerminalQuickCommands, t],
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
        onOk() {
          removeTerminalQuickCommand(command.id);
          message.success(t("quickCommands.deleteSuccess"));
        },
      });
    },
    [removeTerminalQuickCommand, t],
  );

  // 新增
  const openAddDialog = useCallback(() => {
    setEditingCommand(null);
    setDialogOpen(true);
  }, []);

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
                label: `${t("quickCommands.scopeProject")} (${stats.repo})`,
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
        </div>
      </SettingsPageHeader>

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
                key={cmd.id}
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
                          {t("quickCommands.scopeProject")}
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
                    style={{ color: "var(--cs-text-tertiary)", fontFamily: "monospace" }}
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
        repositoryId={repositoryId ?? ""}
      />
    </div>
  );
}
