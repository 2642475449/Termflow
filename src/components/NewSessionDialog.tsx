import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Input, Modal, Select, Spin, Switch } from "antd";
import dayjs from "dayjs";
import { useTranslation } from "react-i18next";
import { getClaudeEffortInfo, inspectAgentClis } from "@/lib/api";
import { formatAgentVersion, getDefaultAgentLaunchOptions, supportsAgentCapability } from "@/lib/agents";
import type {
  AgentCliInfo,
  AiAgentId,
  AntigravitySessionLaunchOptions,
  ClaudeEffortInfo,
  ClaudeEffortLevel,
  ClaudeSessionLaunchOptions,
  CodexSessionLaunchOptions,
  QoderSessionLaunchOptions,
  Session,
  SessionLaunchOptions,
} from "@/types";
import { AgentIcon } from "@/components/AgentIcon";
import { useDefaultInstalledAgentSelection } from "@/hooks/useDefaultInstalledAgentSelection";
import { useAppStore } from "@/store";

interface NewSessionDialogProps {
  open: boolean;
  creating: boolean;
  title?: string;
  onCancel: () => void;
  onCreate: (
    name: string,
    agent: AgentCliInfo,
    launchOptions?: SessionLaunchOptions,
    titleSource?: Session["titleSource"],
  ) => void;
}

const CLAUDE_EFFORT_OPTIONS: ClaudeEffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function NewSessionDialog({
  open,
  creating,
  title,
  onCancel,
  onCreate,
}: NewSessionDialogProps) {
  const { t } = useTranslation();
  const currentProject = useAppStore((state) => state.currentProject);
  const agentPermissionDefaults = useAppStore((state) => state.agentPermissionDefaults);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [agents, setAgents] = useState<AgentCliInfo[]>([]);
  const [agentId, setAgentId] = useState<AiAgentId | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectionFailed, setDetectionFailed] = useState(false);
  const [claudeSkipPermissions, setClaudeSkipPermissions] = useState(false);
  const [claudeEffort, setClaudeEffort] = useState<ClaudeSessionLaunchOptions["effort"]>("inherit");
  const [claudeEffortInfo, setClaudeEffortInfo] = useState<ClaudeEffortInfo | null>(null);

  const [codexYolo, setCodexYolo] = useState(false);
  const [codexApprovalMode, setCodexApprovalMode] = useState<CodexSessionLaunchOptions["approvalMode"]>("on-request");
  const [codexSandboxMode, setCodexSandboxMode] = useState<CodexSessionLaunchOptions["sandboxMode"]>("workspace-write");
  const [codexEffort, setCodexEffort] = useState<CodexSessionLaunchOptions["effort"]>("inherit");
  const [antigravitySkipPermissions, setAntigravitySkipPermissions] = useState(false);
  const [antigravitySandbox, setAntigravitySandbox] = useState(false);
  const [antigravityMode, setAntigravityMode] =
    useState<AntigravitySessionLaunchOptions["mode"]>("inherit");
  const [qoderPermissionMode, setQoderPermissionMode] =
    useState<QoderSessionLaunchOptions["permissionMode"]>("inherit");

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setName(t("sidebar.sessionDefaultName", { time: dayjs().format("HH:mm:ss") }));
    setNameEdited(false);
    setDetecting(true);
    setDetectionFailed(false);
    const claudeDefaults = getDefaultAgentLaunchOptions(
      "claude",
      agentPermissionDefaults,
    ) as ClaudeSessionLaunchOptions;
    const codexDefaults = getDefaultAgentLaunchOptions(
      "codex",
      agentPermissionDefaults,
    ) as CodexSessionLaunchOptions;
    const antigravityDefaults = getDefaultAgentLaunchOptions(
      "antigravity",
      agentPermissionDefaults,
    ) as AntigravitySessionLaunchOptions;
    const qoderDefaults = getDefaultAgentLaunchOptions(
      "qoder",
      agentPermissionDefaults,
    ) as QoderSessionLaunchOptions;
    setClaudeSkipPermissions(claudeDefaults.skipPermissions);
    setClaudeEffort("inherit");
    setClaudeEffortInfo(null);
    setCodexYolo(codexDefaults.yolo);
    setCodexApprovalMode(codexDefaults.approvalMode);
    setCodexSandboxMode(codexDefaults.sandboxMode);
    setCodexEffort("inherit");
    setAntigravitySkipPermissions(antigravityDefaults.dangerouslySkipPermissions);
    setAntigravitySandbox(antigravityDefaults.sandbox);
    setAntigravityMode(antigravityDefaults.mode);
    setQoderPermissionMode(qoderDefaults.permissionMode);

    void inspectAgentClis()
      .then((result) => {
        if (disposed) return;
        const installed = result.filter(
          (agent) =>
            agent.installed &&
            supportsAgentCapability(agent.id, "interactiveTerminal"),
        );
        setAgents(installed);
      })
      .catch((error) => {
        console.error("Failed to inspect agents for new session:", error);
        if (!disposed) {
          setAgents([]);
          setAgentId(null);
          setDetectionFailed(true);
        }
      })
      .finally(() => {
        if (!disposed) setDetecting(false);
      });

    return () => {
      disposed = true;
    };
  }, [agentPermissionDefaults, open, t]);

  useEffect(() => {
    if (!open) return;
    let disposed = false;

    void getClaudeEffortInfo(currentProject?.path ?? null)
      .then((info) => {
        if (!disposed) {
          setClaudeEffortInfo(info);
        }
      })
      .catch((error) => {
        console.error("Failed to load Claude effort info for new session:", error);
        if (!disposed) {
          setClaudeEffortInfo(null);
        }
      });

    return () => {
      disposed = true;
    };
  }, [currentProject?.path, open]);

  useDefaultInstalledAgentSelection({
    enabled: open && !detecting,
    installedAgents: agents,
    selectedAgentId: agentId,
    onSelectedAgentChange: setAgentId,
    emptyValue: null,
  });

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === agentId) ?? null,
    [agentId, agents],
  );
  const inheritedClaudeEffortLabel = useMemo(
    () =>
      claudeEffortInfo
        ? t(`statusBar.effort.${claudeEffortInfo.effectiveLevel}`)
        : t("statusBar.effort.auto"),
    [claudeEffortInfo, t],
  );
  const claudeEffortHint = useMemo(() => {
    if (claudeEffort === "inherit") {
      return t("newSession.effortHintInherit", {
        level: inheritedClaudeEffortLabel,
      });
    }

    return t("newSession.effortHintOverride", {
      level: t(`statusBar.effort.${claudeEffort}`),
    });
  }, [claudeEffort, inheritedClaudeEffortLabel, t]);
  const isClaudeSelected = selectedAgent?.id === "claude";
  const isCodexSelected = selectedAgent?.id === "codex";
  const isAntigravitySelected = selectedAgent?.id === "antigravity";
  const isQoderSelected = selectedAgent?.id === "qoder";
  const canCreate = Boolean(name.trim() && selectedAgent && !detecting && !creating);
  const titleSource: Session["titleSource"] = nameEdited ? "manual" : "default";
  const launchOptions = useMemo(
    () =>
      isClaudeSelected
        ? {
            skipPermissions: claudeSkipPermissions,
            effort: claudeEffort,
          }
        : isCodexSelected
          ? {
              yolo: codexYolo,
              approvalMode: codexApprovalMode,
              sandboxMode: codexSandboxMode,
              effort: codexEffort,
            }
          : isAntigravitySelected
            ? {
                dangerouslySkipPermissions: antigravitySkipPermissions,
                sandbox: antigravitySandbox,
                mode: antigravityMode,
              }
          : isQoderSelected
            ? {
                permissionMode: qoderPermissionMode,
              }
          : undefined,
    [
      claudeEffort,
      claudeSkipPermissions,
      isClaudeSelected,
      isCodexSelected,
      isAntigravitySelected,
      isQoderSelected,
      codexYolo,
      codexApprovalMode,
      codexSandboxMode,
      codexEffort,
      antigravitySkipPermissions,
      antigravitySandbox,
      antigravityMode,
      qoderPermissionMode,
    ],
  );
  const handleConfirmCreate = useCallback(() => {
    if (canCreate && selectedAgent) {
      onCreate(name.trim(), selectedAgent, launchOptions, titleSource);
    }
  }, [canCreate, launchOptions, name, onCreate, selectedAgent, titleSource]);

  return (
    <Modal
      open={open}
      title={title ?? t("newSession.title")}
      okText={t("newSession.create")}
      cancelText={t("common.cancel")}
      confirmLoading={creating}
      okButtonProps={{ disabled: !canCreate }}
      onOk={handleConfirmCreate}
      onCancel={onCancel}
      destroyOnHidden
      width={480}
    >
      <div className="space-y-5 py-3">
        <div>
          <div className="mb-2 text-sm" style={{ color: "var(--cs-text-secondary)" }}>
            {t("newSession.name")}
          </div>
          <Input
            value={name}
            onChange={(event) => {
              setNameEdited(true);
              setName(event.target.value);
            }}
            placeholder={t("newSession.namePlaceholder")}
            maxLength={80}
            autoFocus
            onPressEnter={(event) => {
              if (event.nativeEvent.isComposing) return;
              event.preventDefault();
              handleConfirmCreate();
            }}
          />
        </div>

        <div>
          <div className="mb-2 text-sm" style={{ color: "var(--cs-text-secondary)" }}>
            {t("newSession.agent")}
          </div>
          {detecting ? (
            <div className="flex h-8 items-center gap-2 text-sm" style={{ color: "var(--cs-text-tertiary)" }}>
              <Spin size="small" /> {t("newSession.detecting")}
            </div>
          ) : agents.length > 0 ? (
            <Select
              className="w-full"
              value={agentId}
              placeholder={t("settings.agents.defaultRequired")}
              onChange={(value) => setAgentId(value)}
              options={agents.map((agent) => ({
                value: agent.id,
                label: (
                  <span className="flex items-center gap-2">
                    <AgentIcon agentId={agent.id} />
                    <span>{agent.name}</span>
                    {agent.version && (
                      <span className="truncate text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
                        {formatAgentVersion(agent.version, agent.name)}
                      </span>
                    )}
                  </span>
                ),
              }))}
            />
          ) : (
            <Alert
              type="warning"
              showIcon
              message={t(detectionFailed ? "newSession.detectionFailed" : "newSession.noAgents")}
            />
          )}
        </div>

        {isClaudeSelected ? (
          <div className="space-y-5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm" style={{ color: "var(--cs-text-secondary)" }}>
                  {t("newSession.skipPermissions")}
                </div>
                <div className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
                  {t("newSession.skipPermissionsHint")}
                </div>
              </div>
              <Switch
                checked={claudeSkipPermissions}
                onChange={setClaudeSkipPermissions}
              />
            </div>

            <div>
              <div className="mb-2 text-sm" style={{ color: "var(--cs-text-secondary)" }}>
                {t("newSession.effort")}
              </div>
              <Select
                className="w-full"
                value={claudeEffort}
                onChange={(value) => setClaudeEffort(value)}
                options={[
                  {
                    value: "inherit",
                    label: t("newSession.effortInherit"),
                  },
                  ...CLAUDE_EFFORT_OPTIONS.map((level) => ({
                    value: level,
                    label: t(`statusBar.effort.${level}`),
                  })),
                ]}
              />
              <div className="mt-2 text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
                {claudeEffortHint}
              </div>
            </div>
          </div>
        ) : isCodexSelected ? (
          <div className="space-y-5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm" style={{ color: "var(--cs-text-secondary)" }}>
                  跳过审批和沙箱 (YOLO)
                </div>
              </div>
              <Switch
                checked={codexYolo}
                onChange={setCodexYolo}
              />
            </div>

            <div>
              <div className="mb-2 text-sm" style={{ color: "var(--cs-text-secondary)" }}>
                审批模式
              </div>
              <Select
                className="w-full"
                value={codexApprovalMode}
                onChange={(value) => setCodexApprovalMode(value)}
                disabled={codexYolo}
                options={[
                  { value: "never", label: "永不询问审批" },
                  { value: "on-request", label: "按需审批" },
                  { value: "untrusted", label: "仅不可信命令询问" },
                ]}
              />
            </div>

            <div>
              <div className="mb-2 text-sm" style={{ color: "var(--cs-text-secondary)" }}>
                沙箱模式
              </div>
              <Select
                className="w-full"
                value={codexSandboxMode}
                onChange={(value) => setCodexSandboxMode(value)}
                disabled={codexYolo}
                options={[
                  { value: "workspace-write", label: "工作区可写" },
                  { value: "read-only", label: "只读" },
                ]}
              />
            </div>

            <div>
              <div className="mb-2 text-sm" style={{ color: "var(--cs-text-secondary)" }}>
                思考强度
              </div>
              <Select
                className="w-full"
                value={codexEffort}
                onChange={(value) => setCodexEffort(value)}
                options={[
                  { value: "inherit", label: t("newSession.effortInherit") },
                  { value: "low", label: t("statusBar.effort.low") },
                  { value: "medium", label: t("statusBar.effort.medium") },
                  { value: "high", label: t("statusBar.effort.high") },
                ]}
              />
            </div>
          </div>
        ) : isAntigravitySelected ? (
          <div className="space-y-5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm" style={{ color: "var(--cs-text-secondary)" }}>
                  {t("newSession.antigravitySkipPermissions")}
                </div>
                <div className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
                  {t("newSession.antigravitySkipPermissionsHint")}
                </div>
              </div>
              <Switch
                checked={antigravitySkipPermissions}
                onChange={setAntigravitySkipPermissions}
              />
            </div>

            {antigravitySkipPermissions ? (
              <Alert
                type="warning"
                showIcon
                message={t("newSession.antigravitySkipPermissionsWarning")}
              />
            ) : null}

            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm" style={{ color: "var(--cs-text-secondary)" }}>
                  {t("newSession.antigravitySandbox")}
                </div>
                <div className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
                  {t("newSession.antigravitySandboxHint")}
                </div>
              </div>
              <Switch checked={antigravitySandbox} onChange={setAntigravitySandbox} />
            </div>

            <div>
              <div className="mb-2 text-sm" style={{ color: "var(--cs-text-secondary)" }}>
                {t("newSession.antigravityMode")}
              </div>
              <Select
                className="w-full"
                value={antigravityMode}
                onChange={setAntigravityMode}
                options={[
                  { value: "inherit", label: t("newSession.antigravityModeInherit") },
                  { value: "accept-edits", label: t("newSession.antigravityModeAcceptEdits") },
                  { value: "plan", label: t("newSession.antigravityModePlan") },
                ]}
              />
            </div>
          </div>
        ) : isQoderSelected ? (
          <div className="space-y-4">
            <div>
              <div className="mb-2 text-sm" style={{ color: "var(--cs-text-secondary)" }}>
                {t("newSession.qoderPermissionMode")}
              </div>
              <Select<QoderSessionLaunchOptions["permissionMode"]>
                className="w-full"
                value={qoderPermissionMode}
                onChange={setQoderPermissionMode}
                options={[
                  { value: "inherit", label: t("newSession.qoderPermissionModeInherit") },
                  { value: "default", label: t("newSession.qoderPermissionModeDefault") },
                  { value: "accept_edits", label: t("newSession.qoderPermissionModeAcceptEdits") },
                  { value: "plan", label: t("newSession.qoderPermissionModePlan") },
                  { value: "auto", label: t("newSession.qoderPermissionModeAuto") },
                  { value: "dont_ask", label: t("newSession.qoderPermissionModeDontAsk") },
                  {
                    value: "bypass_permissions",
                    label: t("newSession.qoderPermissionModeBypass"),
                  },
                ]}
              />
              <div className="mt-2 text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
                {t(`newSession.qoderPermissionModeHint.${qoderPermissionMode}`)}
              </div>
            </div>

            {qoderPermissionMode === "bypass_permissions" ? (
              <Alert
                type="warning"
                showIcon
                message={t("newSession.qoderPermissionModeBypassWarning")}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
