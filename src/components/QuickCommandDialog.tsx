import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Input, Switch, Segmented, Collapse, Select, Spin, type InputRef } from "antd";
import { useTranslation } from "react-i18next";
import type { AgentCliInfo, AiAgentId, QuickCommandAction, QuickCommandScope, TerminalQuickCommand } from "@/types";
import { ShortcutHint } from "@/components/ui/ShortcutHint";
import { AgentIcon } from "@/components/AgentIcon";
import { inspectAgentClis } from "@/lib/api";
import { supportsAgentCapability } from "@/lib/agents";
import { useDefaultInstalledAgentSelection } from "@/hooks/useDefaultInstalledAgentSelection";

interface QuickCommandDialogProps {
  open: boolean;
  command: TerminalQuickCommand;
  onSave: (command: TerminalQuickCommand) => void;
  onCancel: () => void;
  repositoryId: string;
}

export function QuickCommandDialog({
  open,
  command,
  onSave,
  onCancel,
  repositoryId,
}: QuickCommandDialogProps) {
  const { t } = useTranslation();

  const [label, setLabel] = useState("");
  const [commandText, setCommandText] = useState("");
  const [action, setAction] = useState<QuickCommandAction>("terminal-command");
  const [appendEnter, setAppendEnter] = useState(true);
  const [scopeType, setScopeType] = useState<"global" | "repository">("repository");
  const [agentId, setAgentId] = useState<AiAgentId | undefined>(undefined);
  const [installedAgents, setInstalledAgents] = useState<AgentCliInfo[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);

  const labelInputRef = useRef<InputRef | null>(null);
  const wasOpenRef = useRef(false);
  const syncedCommandRef = useRef<string>("");

  // 同步传入的 command 到本地状态
  useEffect(() => {
    if (open && (!wasOpenRef.current || syncedCommandRef.current !== command.id)) {
      wasOpenRef.current = true;
      syncedCommandRef.current = command.id;
      setLabel(command.label);
      setCommandText(command.command);
      setAction(command.action);
      setAppendEnter(command.appendEnter !== false);
      setScopeType(command.scope.type === "repository" ? "repository" : "global");
      setAgentId(command.agentId);

      // 聚焦标签输入框
      requestAnimationFrame(() => {
        labelInputRef.current?.focus();
      });
    }
    if (!open) {
      wasOpenRef.current = false;
    }
  }, [open, command]);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void (async () => {
      setAgentsLoading(true);
      try {
        const detectedAgents = await inspectAgentClis();
        if (!disposed) {
          setInstalledAgents(detectedAgents.filter(
            (agent) =>
              agent.installed &&
              supportsAgentCapability(agent.id, "interactiveTerminal") &&
              supportsAgentCapability(agent.id, "initialPrompt"),
          ));
        }
      } catch (error) {
        console.error("Failed to inspect installed agents for quick commands:", error);
        if (!disposed) {
          setInstalledAgents([]);
        }
      } finally {
        if (!disposed) {
          setAgentsLoading(false);
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [open]);

  const { hasInstalledAgents } = useDefaultInstalledAgentSelection({
    enabled: open && action === "agent-prompt" && !agentsLoading,
    installedAgents,
    selectedAgentId: agentId,
    onSelectedAgentChange: setAgentId,
    emptyValue: undefined,
  });

  const isEdit = command.label.length > 0 || command.command.length > 0;
  const canSave =
    label.trim().length > 0
    && commandText.trimEnd().length > 0
    && (action !== "agent-prompt" || !!agentId);

  const handleSave = useCallback(() => {
    if (!canSave) return;

    const finalScope: QuickCommandScope =
      scopeType === "repository"
        ? { type: "repository", repositoryId }
        : { type: "global" };

    onSave({
      ...command,
      label: label.trim(),
      command: commandText.trimEnd(),
      action,
      appendEnter,
      scope: finalScope,
      agentId: action === "agent-prompt" ? agentId : undefined,
    });
  }, [canSave, label, commandText, action, appendEnter, scopeType, repositoryId, command, onSave, agentId]);

  // Ctrl+Enter / Cmd+Enter 提交
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key === "Enter") {
        e.preventDefault();
        handleSave();
      }
    },
    [handleSave],
  );

  return (
    <Modal
      open={open}
      title={isEdit ? t("quickCommands.editCommand") : t("quickCommands.addCommand")}
      onCancel={onCancel}
      destroyOnClose
      width={560}
      footer={[
        <button
          key="cancel"
          className="px-4 py-1.5 text-sm rounded transition-colors"
          style={{
            background: "transparent",
            color: "var(--cs-text-secondary)",
            border: "1px solid var(--cs-border-secondary)",
          }}
          onClick={onCancel}
        >
          {t("quickCommands.cancel")}
        </button>,
        <button
          key="save"
          className="px-4 py-1.5 text-sm rounded transition-colors ml-2"
          style={{
            background: canSave ? "var(--cs-primary)" : "var(--cs-bg-hover)",
            color: canSave ? "#fff" : "var(--cs-text-tertiary)",
            border: "none",
            cursor: canSave ? "pointer" : "not-allowed",
          }}
          onClick={handleSave}
          disabled={!canSave}
        >
          {t("quickCommands.save")}
          <ShortcutHint keys="Ctrl + Enter" />
        </button>,
      ]}
    >
      <div className="flex flex-col gap-4 py-2" onKeyDown={handleKeyDown}>
        <p className="text-sm -mt-1 mb-0" style={{ color: "var(--cs-text-secondary)" }}>
          {t("quickCommands.dialogDescription")}
        </p>
        {/* 标签 */}
        <div>
          <label
            className="block text-sm font-medium mb-1.5"
            style={{ color: "var(--cs-text-secondary)" }}
          >
            {t("quickCommands.label")}
          </label>
          <Input
            ref={labelInputRef}
            size="large"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("quickCommands.labelPlaceholder")}
            maxLength={80}
            allowClear
          />
        </div>

        <div>
          <label
            className="block text-sm font-medium mb-1.5"
            style={{ color: "var(--cs-text-secondary)" }}
          >
            {t("quickCommands.action")}
          </label>
          <Segmented
            size="large"
            value={action}
            onChange={(value) => setAction(value as QuickCommandAction)}
            options={[
              { label: t("quickCommands.actionTerminal"), value: "terminal-command" },
              { label: t("quickCommands.actionAgent"), value: "agent-prompt" },
            ]}
          />
        </div>

        {action === "agent-prompt" && (
          <div>
            <label
              className="block text-sm font-medium mb-1.5"
              style={{ color: "var(--cs-text-secondary)" }}
            >
              {t("quickCommands.agent")}
            </label>
            <Select<AiAgentId>
              size="large"
              value={agentId}
              onChange={(value) => setAgentId(value)}
              placeholder={agentsLoading
                ? t("quickCommands.agentLoading")
                : t("quickCommands.agentPlaceholder")}
              loading={agentsLoading}
              notFoundContent={
                agentsLoading ? <Spin size="small" /> : t("quickCommands.noInstalledAgents")
              }
              options={installedAgents.map((agent) => ({
                value: agent.id,
                label: (
                  <div className="flex items-center gap-2">
                    <AgentIcon agentId={agent.id} size={16} />
                    <span>{agent.name}</span>
                  </div>
                ),
              }))}
              optionFilterProp="label"
              showSearch
            />
            {!agentsLoading && !hasInstalledAgents ? (
              <div className="mt-1.5 text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
                {t("quickCommands.noInstalledAgents")}
              </div>
            ) : null}
            {!agentsLoading && hasInstalledAgents && !agentId ? (
              <div className="mt-1.5 text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
                {t("quickCommands.agentRequired")}
              </div>
            ) : null}
          </div>
        )}

        {/* 命令正文 */}
        <div>
          <label
            className="block text-sm font-medium mb-1.5"
            style={{ color: "var(--cs-text-secondary)" }}
          >
            {t(action === "agent-prompt" ? "quickCommands.promptText" : "quickCommands.commandText")}
          </label>
          <Input.TextArea
            value={commandText}
            onChange={(e) => setCommandText(e.target.value)}
            placeholder={t(
              action === "agent-prompt"
                ? "quickCommands.promptPlaceholder"
                : "quickCommands.commandPlaceholder",
            )}
            autoSize={{ minRows: 6, maxRows: 14 }}
            maxLength={4000}
            style={{ fontFamily: "monospace", fontSize: 16, lineHeight: 1.6 }}
          />
        </div>

        {/* 高级选项 */}
        <Collapse
          ghost
          size="small"
          items={[
            {
              key: "advanced",
              label: (
                <span className="text-sm" style={{ color: "var(--cs-text-secondary)" }}>
                  {t("quickCommands.advanced")}
                </span>
              ),
              children: (
                <div className="flex flex-col gap-3">
                  {/* Append Enter */}
                  {action === "terminal-command" && (
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm" style={{ color: "var(--cs-text-primary)" }}>
                          {t("quickCommands.appendEnter")}
                        </div>
                        <div className="text-sm" style={{ color: "var(--cs-text-tertiary)" }}>
                          {t("quickCommands.appendEnterHint")}
                        </div>
                      </div>
                      <Switch
                        size="small"
                        checked={appendEnter}
                        onChange={setAppendEnter}
                      />
                    </div>
                  )}

                  {/* 作用域 */}
                  <div>
                    <div className="text-sm mb-1.5" style={{ color: "var(--cs-text-primary)" }}>
                      {t("quickCommands.scope")}
                    </div>
                    <Segmented
                      size="small"
                      value={scopeType}
                      onChange={(val) => setScopeType(val as "global" | "repository")}
                      options={[
                        {
                          label: t("quickCommands.scopeProject"),
                          value: "repository",
                        },
                        {
                          label: t("quickCommands.scopeGlobal"),
                          value: "global",
                        },
                      ]}
                    />
                  </div>
                </div>
              ),
            },
          ]}
        />
      </div>
    </Modal>
  );
}
