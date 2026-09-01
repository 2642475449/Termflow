import { useCallback, useMemo, useRef, useState } from "react";
import { Button, Popover, Tooltip, Input, message, Modal, type InputRef } from "antd";
import {
  PlusOutlined,
  PlayCircleOutlined,
  DownOutlined,
  EditOutlined,
  DeleteOutlined,
  CodeOutlined,
  RobotOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/store";
import type { AgentCliInfo, AntigravitySessionLaunchOptions, ClaudeSessionLaunchOptions, QoderSessionLaunchOptions, TerminalQuickCommand } from "@/types";
import {
  isQuickCommandComplete,
  flattenQuickCommand,
  createQuickCommandDraft,
  quickCommandMatchesRepository,
} from "@/lib/quickCommands";
import { searchQuickCommands } from "@/lib/quickCommandSearch";
import { inspectAgentClis, resolveRecentCodexSessionId, spawnPty } from "@/lib/api";
import {
  getAgentCommandShell,
  getAgentDisplayName,
  getAgentStartupCommand,
  getDefaultAgentLaunchOptions,
} from "@/lib/agents";
import { QuickCommandDialog } from "./QuickCommandDialog";
import { AgentIcon } from "@/components/AgentIcon";

export function QuickCommandsButton() {
  const { t } = useTranslation();
  const currentProject = useAppStore((s) => s.currentProject);
  const terminalQuickCommands = useAppStore((s) => s.terminalQuickCommands);
  const setTerminalQuickCommands = useAppStore((s) => s.setTerminalQuickCommands);
  const removeTerminalQuickCommand = useAppStore((s) => s.removeTerminalQuickCommand);
  const addSession = useAppStore((s) => s.addSession);
  const openTab = useAppStore((s) => s.openTab);
  const updateSession = useAppStore((s) => s.updateSession);
  const agentPermissionDefaults = useAppStore((s) => s.agentPermissionDefaults);
  const defaultTerminalShell = useAppStore((s) => s.defaultTerminalShell);

  const [menuOpen, setMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [preferredCommandId, setPreferredCommandId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCommand, setEditingCommand] = useState<TerminalQuickCommand | null>(null);
  const [deletingCommand, setDeletingCommand] = useState<TerminalQuickCommand | null>(null);

  const searchInputRef = useRef<InputRef | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const repositoryId = currentProject?.path ?? null;

  // 过滤出当前仓库可见的命令（仓库命令在前，全局命令在后）
  const { repoCommands, globalCommands, allVisible } = useMemo(() => {
    const repo: TerminalQuickCommand[] = [];
    const global: TerminalQuickCommand[] = [];

    for (const cmd of terminalQuickCommands) {
      if (!isQuickCommandComplete(cmd)) continue;
      if (quickCommandMatchesRepository(cmd, repositoryId)) {
        if (cmd.scope.type === "repository") {
          repo.push(cmd);
        } else {
          global.push(cmd);
        }
      }
    }

    return {
      repoCommands: repo,
      globalCommands: global,
      allVisible: [...repo, ...global],
    };
  }, [terminalQuickCommands, repositoryId]);

  // 搜索过滤
  const filteredCommands = useMemo(() => {
    return searchQuickCommands(searchQuery, allVisible);
  }, [searchQuery, allVisible]);

  // 首选命令（最近使用；不可用时回退到第一条可见命令）
  const preferredCommand = useMemo(() => {
    return allVisible.find((command) => command.id === preferredCommandId)
      ?? allVisible[0]
      ?? null;
  }, [allVisible, preferredCommandId]);

  // 无仓库上下文时隐藏按钮
  if (!repositoryId) {
    return null;
  }

  // 运行命令
  const runCommand = useCallback(
    async (command: TerminalQuickCommand) => {
      setPreferredCommandId(command.id);
      const isAgentPrompt = command.action === "agent-prompt";
      const commandText = isAgentPrompt
        ? command.command.trim()
        : flattenQuickCommand(command.command);
      // Claude Code requires --session-id to be a valid UUID. Keep the app/PTY
      // session id aligned with Claude's conversation id, just like regular sessions.
      const sessionId = crypto.randomUUID();
      const sessionCreatedAt = Date.now();
      const projectPath = currentProject!.path;
      let selectedAgent: AgentCliInfo | null = null;

      if (isAgentPrompt) {
        if (!command.agentId) {
          message.warning(t("quickCommands.agentRequired"));
          return;
        }
        const agents = await inspectAgentClis();
        selectedAgent = agents.find(
          (agent) => agent.id === command.agentId && agent.installed,
        ) ?? null;
        if (!selectedAgent) {
          message.error(t("quickCommands.boundAgentUnavailable", { name: getAgentDisplayName(command.agentId) }));
          return;
        }
      }

      const launchOptions = isAgentPrompt && selectedAgent
        ? getDefaultAgentLaunchOptions(selectedAgent.id, agentPermissionDefaults)
        : undefined;
      const claudeOptions = selectedAgent?.id === "claude"
        ? (launchOptions as ClaudeSessionLaunchOptions | undefined)
        : undefined;
      const antigravityOptions = selectedAgent?.id === "antigravity"
        ? (launchOptions as AntigravitySessionLaunchOptions | undefined)
        : undefined;
      const qoderOptions = selectedAgent?.id === "qoder"
        ? (launchOptions as QoderSessionLaunchOptions | undefined)
        : undefined;
      const claudeSkipPermissions = claudeOptions?.skipPermissions ?? false;

      addSession({
        id: sessionId,
        path: projectPath,
        name: command.label,
        createdAt: sessionCreatedAt,
        active: true,
        ephemeral: !isAgentPrompt,
        hasPromptHistory: isAgentPrompt,
        status: "starting",
        titleSource: "manual",
        agentId: isAgentPrompt ? selectedAgent!.id : defaultTerminalShell,
        agentExecutablePath: isAgentPrompt ? selectedAgent!.executablePath : null,
        agentSessionId: isAgentPrompt && selectedAgent!.id === "pi" ? sessionId : null,
        claudeSkipPermissions: selectedAgent?.id === "claude" ? claudeSkipPermissions : null,
        antigravityDangerouslySkipPermissions:
          selectedAgent?.id === "antigravity" ? antigravityOptions?.dangerouslySkipPermissions ?? false : null,
        antigravitySandbox: selectedAgent?.id === "antigravity" ? antigravityOptions?.sandbox ?? false : null,
        antigravityMode: selectedAgent?.id === "antigravity" ? antigravityOptions?.mode ?? "inherit" : null,
        qoderPermissionMode: selectedAgent?.id === "qoder" ? qoderOptions?.permissionMode ?? "inherit" : null,
      });
      openTab(sessionId);

      try {
        await spawnPty(
          sessionId,
          projectPath,
          false,
          claudeSkipPermissions,
          isAgentPrompt
            ? getAgentStartupCommand(
                selectedAgent!.id,
                selectedAgent!.executablePath,
                selectedAgent!.id === "pi" ? sessionId : null,
                commandText,
                launchOptions,
              )
            : commandText,
          isAgentPrompt ? commandText : undefined,
          isAgentPrompt
            ? getAgentCommandShell(selectedAgent!.id)
            : defaultTerminalShell,
          undefined,
          isAgentPrompt ? selectedAgent!.id : defaultTerminalShell,
        );
        updateSession(sessionId, { active: true, status: "running" });
        if (isAgentPrompt && selectedAgent!.id === "codex") {
          try {
            const codexSessionId = await resolveRecentCodexSessionId(projectPath, sessionCreatedAt);
            if (codexSessionId) {
              updateSession(sessionId, { agentSessionId: codexSessionId });
            }
          } catch (resolveError) {
            // The prompt is already running; failure to discover the resume id should
            // not incorrectly report the whole quick command as failed.
            console.warn("Failed to resolve Codex session id:", resolveError);
          }
        }
      } catch (error) {
        console.error("快速命令执行失败:", error);
        message.error(t("quickCommands.runFailed"));
      }

      setMenuOpen(false);
    },
    [currentProject, addSession, agentPermissionDefaults, defaultTerminalShell, openTab, t, updateSession],
  );

  // 保存命令（新增或编辑）
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
      setDeletingCommand(command);
      setMenuOpen(false);
    },
    [],
  );

  const confirmDeleteCommand = useCallback(() => {
    if (!deletingCommand) return;

    removeTerminalQuickCommand(deletingCommand.id);
    setSelectedIndex((index) => Math.max(0, index - 1));
    setDeletingCommand(null);
    message.success(t("quickCommands.deleteSuccess"));
  }, [deletingCommand, removeTerminalQuickCommand, t]);

  // 打开新增对话框
  const openAddDialog = useCallback(() => {
    setEditingCommand(null);
    setDialogOpen(true);
    setMenuOpen(false);
  }, []);

  // 打开编辑对话框
  const openEditDialog = useCallback((command: TerminalQuickCommand) => {
    setEditingCommand(command);
    setDialogOpen(true);
    setMenuOpen(false);
  }, []);

  // 键盘导航
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const total = filteredCommands.length;
      if (total === 0) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % total);
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + total) % total);
          break;
        case "Enter":
          e.preventDefault();
          if (filteredCommands[selectedIndex]) {
            runCommand(filteredCommands[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          setMenuOpen(false);
          break;
      }
    },
    [filteredCommands, selectedIndex, runCommand],
  );

  // 滚动选中项到视图
  const scrollToSelected = useCallback((index: number) => {
    const list = listRef.current;
    if (!list) return;
    const items = list.querySelectorAll("[data-qc-item]");
    const item = items[index] as HTMLElement | undefined;
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, []);

  // 菜单打开时重置状态
  const handleOpenChange = useCallback(
    (open: boolean) => {
      setMenuOpen(open);
      if (open) {
        setSearchQuery("");
        setSelectedIndex(0);
        // 聚焦搜索框
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
        });
      }
    },
    [],
  );

  // 渲染命令项
  const renderCommandItem = (command: TerminalQuickCommand, index: number) => {
    const isSelected = index === selectedIndex;
    return (
      <div
        key={command.id}
        data-qc-item
        className="flex items-center gap-2 px-3 py-1.5 cursor-pointer rounded transition-colors"
        style={{
          background: isSelected ? "var(--cs-bg-hover)" : "transparent",
          minHeight: 32,
        }}
        onClick={() => runCommand(command)}
        onMouseEnter={() => {
          setSelectedIndex(index);
          scrollToSelected(index);
        }}
      >
        {command.action === "agent-prompt" ? (
          command.agentId ? (
            <AgentIcon agentId={command.agentId} size={14} />
          ) : (
            <RobotOutlined
              style={{ fontSize: 12, color: "var(--cs-primary)", flexShrink: 0 }}
            />
          )
        ) : (
          <CodeOutlined
            style={{ fontSize: 12, color: "var(--cs-text-secondary)", flexShrink: 0 }}
          />
        )}
        <div className="flex-1 min-w-0">
          <div
            className="text-xs font-medium truncate"
            style={{ color: "var(--cs-text-primary)" }}
          >
            {command.label}
          </div>
          <div
            className="text-xs truncate"
            style={{ color: "var(--cs-text-tertiary)" }}
          >
            <span>
              {t(
                command.action === "agent-prompt"
                  ? "quickCommands.actionAgent"
                  : "quickCommands.actionTerminal",
              )} · {command.action === "agent-prompt" && command.agentId
                ? `${getAgentDisplayName(command.agentId)} · `
                : ""}
            </span>
            {command.command}
          </div>
        </div>
        <div
          className="flex items-center gap-1 opacity-0 transition-opacity"
          style={{ opacity: isSelected ? 1 : 0 }}
        >
          <Button
            type="text"
            size="small"
            icon={<EditOutlined style={{ fontSize: 11 }} />}
            onClick={(e) => {
              e.stopPropagation();
              openEditDialog(command);
            }}
            aria-label={t("quickCommands.editCommand")}
          />
          <Button
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined style={{ fontSize: 11 }} />}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              deleteCommand(command);
            }}
            aria-label={t("common.delete")}
          />
        </div>
      </div>
    );
  };

  // 菜单内容
  const menuContent = (
    <div
      style={{ width: 288, maxHeight: 360 }}
      className="flex flex-col"
      onKeyDown={handleKeyDown}
    >
      {/* 搜索框 */}
      {allVisible.length > 1 && (
        <div className="px-2 pt-2 pb-1">
          <Input
            ref={searchInputRef}
            prefix={<SearchOutlined style={{ color: "var(--cs-text-tertiary)", fontSize: 12 }} />}
            placeholder={t("quickCommands.searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSelectedIndex(0);
            }}
            size="small"
            allowClear
            style={{ borderRadius: 6 }}
          />
        </div>
      )}

      {/* 命令列表 */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-1 py-1" style={{ maxHeight: 260 }}>
        {filteredCommands.length === 0 ? (
          <div
            className="text-xs text-center py-4"
            style={{ color: "var(--cs-text-tertiary)" }}
          >
            {searchQuery ? t("quickCommands.noCommands") : t("quickCommands.noCommands")}
          </div>
        ) : (
          <>
            {/* 仓库命令 */}
            {repoCommands.length > 0 && (
              <div>
                {searchQuery
                  ? filteredCommands
                      .filter((c) => c.scope.type === "repository")
                      .map((c) => renderCommandItem(c, filteredCommands.indexOf(c)))
                  : repoCommands.map((c, i) => renderCommandItem(c, i))}
              </div>
            )}

            {/* 分隔线 */}
            {repoCommands.length > 0 && globalCommands.length > 0 && !searchQuery && (
              <div
                className="my-1 mx-2"
                style={{ borderTop: "1px solid var(--cs-border-secondary)" }}
              />
            )}

            {/* 全局命令 */}
            {globalCommands.length > 0 && (
              <div>
                {searchQuery
                  ? filteredCommands
                      .filter((c) => c.scope.type === "global")
                      .map((c) => renderCommandItem(c, filteredCommands.indexOf(c)))
                  : globalCommands.map((c, i) =>
                      renderCommandItem(c, repoCommands.length + i),
                    )}
              </div>
            )}
          </>
        )}
      </div>

      {/* 底部添加按钮 */}
      <div
        className="px-2 py-1.5"
        style={{ borderTop: "1px solid var(--cs-border-secondary)" }}
      >
        <Button
          type="text"
          block
          size="small"
          icon={<PlusOutlined style={{ fontSize: 11 }} />}
          onClick={openAddDialog}
          style={{ textAlign: "left", fontSize: 12 }}
        >
          {t("quickCommands.addCommand")}
        </Button>
      </div>
    </div>
  );

  // 空状态：显示添加按钮
  if (allVisible.length === 0) {
    return (
      <>
        <Tooltip title={t("quickCommands.addTooltip")}>
          <button
            type="button"
            className="quick-command-trigger quick-command-trigger-single"
            onClick={openAddDialog}
          >
            <PlusOutlined style={{ fontSize: 10 }} />
            <span className="leading-none">{t("quickCommands.addCommand")}</span>
          </button>
        </Tooltip>
        <QuickCommandDialog
          open={dialogOpen}
          command={editingCommand ?? createQuickCommandDraft({ type: "repository", repositoryId })}
          onSave={saveCommand}
          onCancel={() => {
            setDialogOpen(false);
            setEditingCommand(null);
          }}
          repositoryId={repositoryId}
        />
      </>
    );
  }

  // 非空状态：分裂按钮
  return (
    <>
      <div className="quick-command-trigger-group">
        {/* 左侧主按钮：运行首选命令 */}
        <Tooltip
          title={
            preferredCommand
              ? `${preferredCommand.label}: ${preferredCommand.command}`
              : undefined
          }
        >
          <button
            type="button"
            className="quick-command-trigger-part quick-command-trigger-main"
            onClick={() => preferredCommand && runCommand(preferredCommand)}
            disabled={!preferredCommand}
          >
            {preferredCommand?.action === "agent-prompt" ? (
              preferredCommand.agentId ? (
                <AgentIcon agentId={preferredCommand.agentId} size={14} />
              ) : (
                <RobotOutlined style={{ fontSize: 12, flexShrink: 0 }} />
              )
            ) : (
              <PlayCircleOutlined style={{ fontSize: 12, flexShrink: 0 }} />
            )}
            <span className="truncate leading-none">{preferredCommand?.label ?? ""}</span>
          </button>
        </Tooltip>

        {/* 右侧下拉箭头 */}
        <Popover
          content={menuContent}
          trigger="click"
          open={menuOpen}
          onOpenChange={handleOpenChange}
          placement="bottomRight"
          overlayInnerStyle={{ padding: 0 }}
          arrow={false}
        >
          <button
            type="button"
            className="quick-command-trigger-part quick-command-trigger-menu"
            data-open={menuOpen ? "true" : "false"}
            aria-label={t("settings.menu.quickCommands")}
            aria-expanded={menuOpen}
          >
            <DownOutlined style={{ fontSize: 9 }} />
          </button>
        </Popover>
      </div>

      <QuickCommandDialog
        open={dialogOpen}
        command={editingCommand ?? createQuickCommandDraft({ type: "repository", repositoryId })}
        onSave={saveCommand}
        onCancel={() => {
          setDialogOpen(false);
          setEditingCommand(null);
        }}
        repositoryId={repositoryId}
      />

      <Modal
        open={deletingCommand !== null}
        title={t("quickCommands.deleteConfirmTitle")}
        okText={t("common.confirm")}
        cancelText={t("common.cancel")}
        okButtonProps={{ danger: true }}
        onOk={confirmDeleteCommand}
        onCancel={() => setDeletingCommand(null)}
        destroyOnHidden
      >
        {deletingCommand && (
          <p>{t("quickCommands.deleteConfirmContent", { label: deletingCommand.label })}</p>
        )}
      </Modal>
    </>
  );
}
