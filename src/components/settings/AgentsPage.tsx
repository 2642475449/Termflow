import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircleFilled, CloseCircleFilled, CopyOutlined, DownOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Drawer, Dropdown, Spin, Tag, message } from "antd";
import { useTranslation } from "react-i18next";
import { getClaudeRateLimits, getCodexRateLimits, getQoderUsage, inspectAgentClis } from "@/lib/api";
import { AGENT_DEFINITIONS, AI_AGENT_ORDER, formatAgentVersion } from "@/lib/agents";
import type { AgentCliInfo, AiAgentId, ClaudeRateLimits, CodexRateLimitWindow, CodexRateLimits, QoderUsage } from "@/types";
import { AgentIcon } from "@/components/AgentIcon";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import { useAppStore } from "@/store";

type Quotas = { claude: ClaudeRateLimits | null; codex: CodexRateLimits | null; qoder: QoderUsage | null };
const EMPTY_QUOTAS: Quotas = { claude: null, codex: null, qoder: null };

export function AgentsPage() {
  const { t, i18n } = useTranslation();
  const defaultAgentId = useAppStore((state) => state.defaultAgentId);
  const setDefaultAgentId = useAppStore((state) => state.setDefaultAgentId);
  const sessions = useAppStore((state) => state.sessions);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const [agents, setAgents] = useState<AgentCliInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotas, setQuotas] = useState<Quotas>(EMPTY_QUOTAS);
  const [selectedAgentId, setSelectedAgentId] = useState<AiAgentId | null>(null);

  const claudeSessionId = useMemo(() => {
    const active = sessions.find((session) => session.id === activeSessionId);
    if (active?.agentId === "claude") return active.id;
    return sessions.find((session) => session.agentId === "claude")?.id ?? null;
  }, [activeSessionId, sessions]);

  const loadQuotas = useCallback(async (detected: AgentCliInfo[], forceRefresh = false) => {
    const installed = new Set(detected.filter((agent) => agent.installed).map((agent) => agent.id));
    setQuotaLoading(true);
    try {
      const [claude, codex, qoder] = await Promise.allSettled([
        installed.has("claude") && claudeSessionId ? getClaudeRateLimits(claudeSessionId) : Promise.resolve(null),
        installed.has("codex") ? getCodexRateLimits({ forceRefresh }) : Promise.resolve(null),
        installed.has("qoder") ? getQoderUsage({ forceRefresh }) : Promise.resolve(null),
      ]);
      setQuotas({
        claude: claude.status === "fulfilled" ? claude.value : null,
        codex: codex.status === "fulfilled" ? codex.value : null,
        qoder: qoder.status === "fulfilled" ? qoder.value : null,
      });
    } finally {
      setQuotaLoading(false);
    }
  }, [claudeSessionId]);

  const refresh = useCallback(async (showSuccess = false) => {
    setLoading(true);
    try {
      const result = [...await inspectAgentClis({ forceRefresh: showSuccess })].sort(
        (left, right) => AI_AGENT_ORDER.indexOf(left.id) - AI_AGENT_ORDER.indexOf(right.id),
      );
      setAgents(result);
      void loadQuotas(result, showSuccess);
      if (showSuccess) message.success(t("settings.agents.refreshSuccess"));
    } catch (error) {
      console.error("Failed to inspect agent CLIs:", error);
      message.error(t("settings.agents.refreshFailed"));
    } finally {
      setLoading(false);
    }
  }, [loadQuotas, t]);

  useEffect(() => { void refresh(); }, [refresh]);

  const checkedAt = agents[0]?.checkedAt;
  const defaultAgent = agents.find((agent) => agent.id === defaultAgentId) ?? null;
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null;

  const selectDefault = useCallback((agent: AgentCliInfo) => {
    if (!agent.installed) return;
    setDefaultAgentId(agent.id);
    message.success(t("settings.agents.defaultChanged", { name: AGENT_DEFINITIONS[agent.id].displayName }));
  }, [setDefaultAgentId, t]);

  const copyInstall = useCallback(async (agent: AgentCliInfo, command: string, shell?: string) => {
    try {
      await navigator.clipboard.writeText(command);
      message.success(t("settings.agents.installCommandCopied", { name: AGENT_DEFINITIONS[agent.id].displayName, shell }));
    } catch (error) {
      console.error("Failed to copy agent installation command:", error);
      message.error(t("settings.agents.installCommandCopyFailed"));
    }
  }, [t]);

  return (
    <div className="mx-auto max-w-5xl">
      <SettingsPageHeader
        title={t("settings.agents.title")}
        description={t("settings.agents.subtitleWithQuota")}
        actions={<Button icon={<ReloadOutlined />} loading={loading || quotaLoading} onClick={() => void refresh(true)}>{t("settings.agents.refresh")}</Button>}
      />

      <div className="app-glass-card mb-4 rounded-xl px-4 py-3" style={{ background: "var(--cs-bg-card)", border: "1px solid var(--cs-border-card)" }}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>{t("settings.agents.defaultTitle")}</div>
          {checkedAt ? <span className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.agents.checkedAt", { time: new Intl.DateTimeFormat(i18n.resolvedLanguage, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(checkedAt) })}</span> : null}
        </div>
        <div className="mt-1 text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
          {defaultAgent?.installed
            ? t("settings.agents.defaultCurrent", { name: AGENT_DEFINITIONS[defaultAgent.id].displayName })
            : defaultAgentId ? t("settings.agents.defaultUnavailable") : t("settings.agents.defaultMissing")}
        </div>
      </div>

      {loading && agents.length === 0 ? <div className="flex min-h-64 items-center justify-center"><Spin /></div> : (
        <div className="app-glass-card overflow-x-auto rounded-xl" style={{ background: "var(--cs-bg-card)", border: "1px solid var(--cs-border-card)", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          {agents.map((agent, index) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              quota={agent.id === "claude" ? quotas.claude : agent.id === "codex" ? quotas.codex : agent.id === "qoder" ? quotas.qoder : null}
              quotaLoading={quotaLoading}
              isDefault={defaultAgentId === agent.id}
              isLast={index === agents.length - 1}
              onOpen={() => setSelectedAgentId(agent.id)}
              onSetDefault={() => selectDefault(agent)}
              onCopyInstall={(command, shell) => void copyInstall(agent, command, shell)}
            />
          ))}
        </div>
      )}

      <div className="mt-5 text-xs leading-5" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.agents.detailHint")}</div>
      <AgentDetailsDrawer agent={selectedAgent} open={selectedAgent !== null} onClose={() => setSelectedAgentId(null)} />
    </div>
  );
}

function AgentRow({ agent, quota, quotaLoading, isDefault, isLast, onOpen, onSetDefault, onCopyInstall }: {
  agent: AgentCliInfo;
  quota: ClaudeRateLimits | CodexRateLimits | QoderUsage | null;
  quotaLoading: boolean;
  isDefault: boolean;
  isLast: boolean;
  onOpen: () => void;
  onSetDefault: () => void;
  onCopyInstall: (command: string, shell?: string) => void;
}) {
  const { t } = useTranslation();
  const definition = AGENT_DEFINITIONS[agent.id];
  const version = formatAgentVersion(agent.version, definition.displayName);
  return (
    <div
      role="button"
      tabIndex={0}
      className="grid min-h-[78px] min-w-[820px] cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--cs-bg-hover)]"
      style={{ gridTemplateColumns: "minmax(230px,1.2fr) 108px minmax(220px,1fr) 156px", borderBottom: isLast ? "none" : "1px solid var(--cs-border-card)" }}
      onClick={onOpen}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl" style={{ background: `${definition.brandColor}16`, border: `1px solid ${definition.brandColor}32` }}><AgentIcon agentId={agent.id} size={25} /></div>
        <div className="min-w-0">
          <div className="truncate text-base font-semibold" style={{ color: "var(--cs-text-primary)" }}>{definition.displayName}</div>
          <div className="flex min-w-0 items-center gap-1.5 text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
            <code className="truncate">{definition.command}</code>{version ? <><span>·</span><span className="truncate">{version}</span></> : null}
          </div>
        </div>
      </div>
      <Tag icon={agent.installed ? <CheckCircleFilled /> : <CloseCircleFilled />} color={agent.installed ? "success" : "default"} className="m-0 w-fit shrink-0">{t(agent.installed ? "settings.agents.installed" : "settings.agents.notInstalled")}</Tag>
      <AgentQuota agent={agent} quota={quota} loading={quotaLoading} />
      <div className="justify-self-end" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
        {!agent.installed ? (
          definition.installCommands.length > 1 ? (
            <Dropdown trigger={["click"]} menu={{ items: definition.installCommands.map(({ shell }) => ({ key: shell, label: shell })), onClick: ({ key }) => { const selected = definition.installCommands.find(({ shell }) => shell === key); if (selected) onCopyInstall(selected.command, selected.shell); } }}>
              <Button className="w-[150px]" icon={<CopyOutlined />}>{t("settings.agents.copyInstallCommand")} <DownOutlined className="text-[10px]" /></Button>
            </Dropdown>
          ) : (
            <Button className="w-[150px]" icon={<CopyOutlined />} onClick={() => { const [install] = definition.installCommands; if (install) onCopyInstall(install.command, install.shell); }}>{t("settings.agents.copyInstallCommand")}</Button>
          )
        ) : (
          <Button className="w-[150px]" type={isDefault ? "primary" : "default"} disabled={isDefault} onClick={onSetDefault}>{t(isDefault ? "settings.agents.defaultActive" : "settings.agents.setDefault")}</Button>
        )}
      </div>
    </div>
  );
}

function AgentQuota({ agent, quota, loading }: { agent: AgentCliInfo; quota: ClaudeRateLimits | CodexRateLimits | QoderUsage | null; loading: boolean }) {
  const { t } = useTranslation();
  if (!agent.installed) return <Muted>{t("settings.agents.quota.installFirst")}</Muted>;
  if (agent.id === "antigravity" || agent.id === "opencode") return <Muted>{t("settings.agents.quota.unsupported")}</Muted>;
  if (loading && !quota) return <Muted>{t("settings.agents.quota.loading")}</Muted>;

  if (agent.id === "qoder") {
    const usage = quota as QoderUsage | null;
    if (usage?.status !== "ok") return <QuotaUnavailable agentId={agent.id} />;
    const used = usage.totalUsagePercentage ?? usage.userQuota?.percentage ?? null;
    const percent = used == null ? null : clampPercent(100 - used);
    const credits = usage.userQuota?.remaining ?? null;
    const headline = credits != null
      ? t("settings.agents.quota.remainingCredits", { value: formatNumber(credits) })
      : percent != null ? t("settings.agents.quota.remainingPercent", { value: percent }) : null;
    return headline ? <QuotaSummary headline={headline} percentages={percent == null ? [] : [percent]} /> : <QuotaUnavailable agentId={agent.id} />;
  }

  const limits = quota as ClaudeRateLimits | CodexRateLimits | null;
  if (limits?.status !== "ok") return <QuotaUnavailable agentId={agent.id} />;
  const windows = [limits.session, limits.weekly].filter((window): window is CodexRateLimitWindow => window !== null);
  if (windows.length === 0) return <QuotaUnavailable agentId={agent.id} />;
  const percentages = windows.map((window) => clampPercent(100 - window.usedPercent));
  const detail = [
    limits.session ? t("settings.agents.quota.session", { value: clampPercent(100 - limits.session.usedPercent) }) : null,
    limits.weekly ? t("settings.agents.quota.weekly", { value: clampPercent(100 - limits.weekly.usedPercent) }) : null,
  ].filter(Boolean).join(" · ");
  return <QuotaSummary headline={quotaHeadline(Math.min(...percentages), t)} detail={detail} percentages={percentages} />;
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="truncate text-xs" style={{ color: "var(--cs-text-tertiary)" }}>{children}</span>;
}

function QuotaUnavailable({ agentId }: { agentId: AiAgentId }) {
  const { t } = useTranslation();
  return <Muted>{t(agentId === "claude" ? "settings.agents.quota.startSession" : "settings.agents.quota.unavailable")}</Muted>;
}

function QuotaSummary({ headline, detail, percentages }: { headline: string; detail?: string; percentages: number[] }) {
  const minimum = percentages.length ? Math.min(...percentages) : 100;
  const color = minimum <= 5 ? "var(--cs-danger)" : minimum <= 20 ? "var(--cs-warning)" : "var(--cs-success)";
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-3">
        <span className="truncate text-sm font-semibold" style={{ color: "var(--cs-text-primary)" }}>{headline}</span>
        {percentages.length ? <div className="flex shrink-0 gap-1.5" aria-hidden="true">{percentages.map((percentage, index) => <div key={index} className="h-1.5 w-14 overflow-hidden rounded-full" style={{ background: "color-mix(in srgb, var(--cs-text-tertiary) 20%, transparent)" }}><div className="h-full rounded-full" style={{ width: `${percentage}%`, background: color }} /></div>)}</div> : null}
      </div>
      {detail ? <div className="mt-1 truncate text-[11px] tabular-nums" style={{ color: "var(--cs-text-tertiary)" }}>{detail}</div> : null}
    </div>
  );
}

function AgentDetailsDrawer({ agent, open, onClose }: { agent: AgentCliInfo | null; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const definition = agent ? AGENT_DEFINITIONS[agent.id] : null;
  return (
    <Drawer open={open} width={420} title={definition?.displayName} onClose={onClose} destroyOnHidden>
      {agent && definition ? <div className="space-y-5">
        <AgentDetail label={t("settings.agents.version")}>{formatAgentVersion(agent.version, definition.displayName) || t("settings.agents.unknown")}</AgentDetail>
        <AgentDetail label={t("settings.agents.path")}>{agent.executablePath ? <span className="break-all font-mono text-xs">{agent.executablePath}</span> : t("settings.agents.notFoundInPath")}</AgentDetail>
        {agent.error ? <AgentDetail label={t("settings.agents.versionError")}><span style={{ color: "var(--cs-danger)" }}>{agent.error}</span></AgentDetail> : null}
      </div> : null}
    </Drawer>
  );
}

function AgentDetail({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><div className="mb-1 text-xs" style={{ color: "var(--cs-text-tertiary)" }}>{label}</div><div className="text-sm" style={{ color: "var(--cs-text-secondary)" }}>{children}</div></div>;
}

function clampPercent(value: number) { return Math.max(0, Math.min(100, Math.round(value))); }
function formatNumber(value: number) { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value); }
function quotaHeadline(remaining: number, t: ReturnType<typeof useTranslation>["t"]) {
  if (remaining <= 5) return t("settings.agents.quota.exhausted");
  if (remaining <= 20) return t("settings.agents.quota.low");
  return t("settings.agents.quota.healthy");
}
