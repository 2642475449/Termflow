import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircleFilled, CheckOutlined, CloseCircleFilled, CopyOutlined, DownOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Drawer, Dropdown, Spin, Tag, message } from "antd";
import { useTranslation } from "react-i18next";
import { getAntigravityUsage, getClaudeRateLimits, getCodexRateLimits, getQoderUsage, inspectAgentClis } from "@/lib/api";
import { AGENT_DEFINITIONS, AI_AGENT_ORDER, formatAgentVersion } from "@/lib/agents";
import type { AgentCliInfo, AiAgentId, AntigravityQuotaWindow, AntigravityUsage, ClaudeRateLimits, CodexRateLimitWindow, CodexRateLimits, QoderUsage } from "@/types";
import { AgentIcon } from "@/components/AgentIcon";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import { useAppStore } from "@/store";
import { useAgentVersionsStore } from "@/store/slices/agentVersions";
import { compareAgentVersion } from "@/lib/agentVersions";

type Quotas = { claude: ClaudeRateLimits | null; codex: CodexRateLimits | null; antigravity: AntigravityUsage | null; qoder: QoderUsage | null };
const EMPTY_QUOTAS: Quotas = { claude: null, codex: null, antigravity: null, qoder: null };
const QUOTA_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
const QUOTA_RESUME_MAX_AGE_MS = 60 * 1000;

export function AgentsPage() {
  const { t, i18n } = useTranslation();
  const setVersionChecks = useAgentVersionsStore((state) => state.setVersionChecks);
  const versionLoading = useAgentVersionsStore((state) => Object.values(state.versions).some((version) => version.status === "checking"));
  const defaultAgentId = useAppStore((state) => state.defaultAgentId);
  const setDefaultAgentId = useAppStore((state) => state.setDefaultAgentId);
  const sessions = useAppStore((state) => state.sessions);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const [agents, setAgents] = useState<AgentCliInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaRefreshFailed, setQuotaRefreshFailed] = useState(false);
  const [quotas, setQuotas] = useState<Quotas>(EMPTY_QUOTAS);
  const [selectedAgentId, setSelectedAgentId] = useState<AiAgentId | null>(null);
  const quotaRequestRef = useRef<Promise<void> | null>(null);
  const lastQuotaRefreshAtRef = useRef(0);

  const claudeSessionId = useMemo(() => {
    const active = sessions.find((session) => session.id === activeSessionId);
    if (active?.agentId === "claude") return active.id;
    return sessions.find((session) => session.agentId === "claude")?.id ?? null;
  }, [activeSessionId, sessions]);

  const loadQuotas = useCallback((detected: AgentCliInfo[], forceRefresh = false): Promise<void> => {
    if (quotaRequestRef.current) return quotaRequestRef.current;

    const installed = new Set(detected.filter((agent) => agent.installed).map((agent) => agent.id));
    setQuotaLoading(true);
    const request = (async () => {
      const [claude, codex, antigravity, qoder] = await Promise.allSettled([
        installed.has("claude") && claudeSessionId ? getClaudeRateLimits(claudeSessionId) : Promise.resolve(null),
        installed.has("codex") ? getCodexRateLimits({ forceRefresh }) : Promise.resolve(null),
        installed.has("antigravity") ? getAntigravityUsage({ forceRefresh }) : Promise.resolve(null),
        installed.has("qoder") ? getQoderUsage({ forceRefresh }) : Promise.resolve(null),
      ]);
      setQuotas((current) => ({
        claude: claude.status === "fulfilled" ? claude.value : current.claude,
        codex: codex.status === "fulfilled" ? codex.value : current.codex,
        antigravity: antigravity.status === "fulfilled" && antigravity.value?.status === "ok"
          ? antigravity.value
          : current.antigravity ?? (antigravity.status === "fulfilled" ? antigravity.value : null),
        qoder: qoder.status === "fulfilled" ? qoder.value : current.qoder,
      }));
      setQuotaRefreshFailed(
        claude.status === "rejected" || codex.status === "rejected" || antigravity.status === "rejected" || qoder.status === "rejected",
      );
    })().finally(() => {
      lastQuotaRefreshAtRef.current = Date.now();
      setQuotaLoading(false);
      quotaRequestRef.current = null;
    });
    quotaRequestRef.current = request;
    return request;
  }, [claudeSessionId]);

  const refresh = useCallback(async (showSuccess = false) => {
    void setVersionChecks(showSuccess);
    setLoading(true);
    try {
      const result = [...await inspectAgentClis({ forceRefresh: showSuccess })].sort(
        (left, right) => AI_AGENT_ORDER.indexOf(left.id) - AI_AGENT_ORDER.indexOf(right.id),
      );
      setAgents(result);
      await loadQuotas(result, showSuccess);
      if (showSuccess) message.success(t("settings.agents.refreshSuccess"));
    } catch (error) {
      console.error("Failed to inspect agent CLIs:", error);
      message.error(t("settings.agents.refreshFailed"));
    } finally {
      setLoading(false);
    }
  }, [loadQuotas, setVersionChecks, t]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (agents.length === 0) return;

    const refreshVisibleQuotas = () => {
      if (document.visibilityState !== "visible") return;
      void loadQuotas(agents, true);
    };
    const interval = window.setInterval(refreshVisibleQuotas, QUOTA_REFRESH_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastQuotaRefreshAtRef.current < QUOTA_RESUME_MAX_AGE_MS) return;
      refreshVisibleQuotas();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [agents, loadQuotas]);

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
        actions={<Button icon={<ReloadOutlined />} loading={loading || quotaLoading || versionLoading} onClick={() => void refresh(true)}>{t("settings.agents.refresh")}</Button>}
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
        {quotaRefreshFailed ? <div className="mt-1 text-xs" style={{ color: "var(--cs-warning)" }}>{t("settings.agents.quota.refreshFailed")}</div> : null}
      </div>

      {loading && agents.length === 0 ? <div className="flex min-h-64 items-center justify-center"><Spin /></div> : (
        <div className="app-glass-card overflow-x-auto rounded-xl" style={{ background: "var(--cs-bg-card)", border: "1px solid var(--cs-border-card)", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          {agents.map((agent, index) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              quota={agent.id === "claude" ? quotas.claude : agent.id === "codex" ? quotas.codex : agent.id === "antigravity" ? quotas.antigravity : agent.id === "qoder" ? quotas.qoder : null}
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
      <AgentDetailsDrawer agent={selectedAgent} open={selectedAgent !== null} onClose={() => setSelectedAgentId(null)} quotas={quotas} quotaLoading={quotaLoading} refreshing={loading || quotaLoading || versionLoading} onRefresh={() => void refresh(true)} onSetDefault={() => { if (selectedAgent) selectDefault(selectedAgent); }} onCopyInstall={(command, shell) => { if (selectedAgent) void copyInstall(selectedAgent, command, shell); }} />
    </div>
  );
}

function AgentRow({ agent, quota, quotaLoading, isDefault, isLast, onOpen, onSetDefault, onCopyInstall }: {
  agent: AgentCliInfo;
  quota: ClaudeRateLimits | CodexRateLimits | AntigravityUsage | QoderUsage | null;
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
          <div className="mt-1"><AgentVersionStatus agent={agent} /></div>
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
          <Button className="w-[150px]" type={isDefault ? "primary" : "default"} disabled={isDefault} icon={isDefault ? <CheckOutlined /> : undefined} onClick={onSetDefault}>{t(isDefault ? "settings.agents.defaultActive" : "settings.agents.setDefault")}</Button>
        )}
      </div>
    </div>
  );
}

function AgentQuota({ agent, quota, loading, expanded = false }: { agent: AgentCliInfo; quota: ClaudeRateLimits | CodexRateLimits | AntigravityUsage | QoderUsage | null; loading: boolean; expanded?: boolean }) {
  const { t } = useTranslation();
  if (agent.id === "pi") return <div className="h-[38px]" aria-hidden="true" />;
  if (!agent.installed) return <Muted>{t("settings.agents.quota.installFirst")}</Muted>;
  if (agent.id === "opencode") return <Muted>{t("settings.agents.quota.unsupported")}</Muted>;
  if (loading && !quota) return <Muted>{t("settings.agents.quota.loading")}</Muted>;

  if (agent.id === "antigravity") {
    const usage = quota as AntigravityUsage | null;
    if (usage?.status !== "ok" || usage.windows.length === 0) return <QuotaUnavailable agentId={agent.id} />;
    const percentages = usage.windows.map((window) => clampPercent(window.remainingPercent));
    const quotaPair = (scope: string) => {
      const session = usage.windows.find((window) => window.scope === scope && window.window === "session");
      const weekly = usage.windows.find((window) => window.scope === scope && window.window === "weekly");
      const value = (window: typeof session) => window ? clampPercent(window.remainingPercent) : "–";
      return `${value(session)} / ${value(weekly)}%`;
    };
    const detail = [
      `${t("settings.agents.quota.sessionShort")}/${t("settings.agents.quota.weeklyShort")}`,
      `${t("settings.agents.quota.gemini")} ${quotaPair("Gemini")}`,
      `${t("settings.agents.quota.claudeGpt")} ${quotaPair("Claude and GPT")}`,
    ].join(" · ");
    const minimum = Math.min(...percentages);
    return <QuotaSummary headline={quotaHeadline(minimum, t)} detail={detail} percentages={[minimum]} />;
  }

  if (agent.id === "qoder") {
    const usage = quota as QoderUsage | null;
    if (usage?.status !== "ok") return <QuotaUnavailable agentId={agent.id} />;
    const used = usage.totalUsagePercentage ?? usage.userQuota?.percentage ?? null;
    const percent = used == null ? null : clampPercent(100 - used);
    const credits = usage.userQuota?.remaining ?? null;
    const headline = credits != null
      ? t("settings.agents.quota.remainingCredits", { value: formatNumber(credits) })
      : percent != null ? t("settings.agents.quota.remainingPercent", { value: percent }) : null;
    if (!headline) return <QuotaUnavailable agentId={agent.id} />;
    if (expanded) return (
      <div className="space-y-4">
        <QuotaDetailsHeader headline={headline} updatedAt={usage.updatedAt} />
        {percent != null && <QuotaWindowDetail label={t("settings.agents.details.quota")} remaining={percent} />}
      </div>
    );
    return <QuotaSummary headline={headline} percentages={percent == null ? [] : [percent]} />;
  }

  const limits = quota as ClaudeRateLimits | CodexRateLimits | null;
  if (limits?.status !== "ok") return <QuotaUnavailable agentId={agent.id} />;
  const windows = [limits.session, limits.weekly].filter((window): window is CodexRateLimitWindow => window !== null);
  if (windows.length === 0) return <QuotaUnavailable agentId={agent.id} />;
  const percentages = windows.map((window) => clampPercent(100 - window.usedPercent));
  if (expanded) return (
    <div className="space-y-4">
      <QuotaDetailsHeader headline={quotaHeadline(Math.min(...percentages), t)} updatedAt={limits.updatedAt} />
      {(["session", "weekly"] as const).map((period) => {
        const window = limits[period];
        return window ? <QuotaWindowDetail key={period}
          label={t(`settings.agents.quota.${period}Short`)}
          remaining={clampPercent(100 - window.usedPercent)}
          resetDescription={window.resetDescription ?? (window.resetsAt != null ? new Date(window.resetsAt).toISOString() : null)} /> : null;
      })}
    </div>
  );
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
  return <Muted>{t(agentId === "claude" || agentId === "antigravity" ? "settings.agents.quota.startSession" : "settings.agents.quota.unavailable")}</Muted>;
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

function AgentDetailsDrawer({ agent, open, onClose, quotas, quotaLoading, refreshing, onRefresh, onSetDefault, onCopyInstall }: {
  agent: AgentCliInfo | null; open: boolean; onClose: () => void;
  quotas: Quotas; quotaLoading: boolean; refreshing: boolean;
  onRefresh: () => void; onSetDefault: () => void;
  onCopyInstall: (command: string, shell: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const defaultAgentId = useAppStore((state) => state.defaultAgentId);
  const isDefault = agent?.id === defaultAgentId;
  const definition = agent ? AGENT_DEFINITIONS[agent.id] : null;
  const quota = agent && agent.id in quotas ? quotas[agent.id as keyof Quotas] : null;
  const copyPath = async () => {
    if (!agent?.executablePath) return;
    try {
      await navigator.clipboard.writeText(agent.executablePath);
      message.success(t("settings.agents.details.pathCopied"));
    } catch {
      message.error(t("settings.agents.details.pathCopyFailed"));
    }
  };
  return (
    <Drawer open={open} width={520} title={definition?.displayName} onClose={onClose} destroyOnHidden>
      {agent && definition ? <div className="app-agent-details space-y-5">
        <section className="rounded-xl border border-[var(--cs-border-card)] bg-[var(--cs-bg-card)] p-4">
          <div className="flex items-center gap-3">
            <AgentIcon agentId={agent.id} size={36} />
            <div className="min-w-0 flex-1">
              <div className="text-lg font-semibold text-[var(--cs-text-primary)]">{definition.displayName}</div>
              <code className="text-xs text-[var(--cs-text-tertiary)]">{definition.command}</code>
            </div>
            <Tag color={agent.installed ? "success" : "default"} className="m-0">{t(agent.installed ? "settings.agents.installed" : "settings.agents.notInstalled")}</Tag>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button type={isDefault ? "default" : "primary"} disabled={!agent.installed || isDefault} onClick={onSetDefault}>{t(isDefault ? "settings.agents.defaultActive" : "settings.agents.setDefault")}</Button>
            <Button icon={<ReloadOutlined />} loading={refreshing} onClick={onRefresh}>{t("settings.agents.refresh")}</Button>
          </div>
          {isDefault ? <p className="mb-0 mt-3 text-xs leading-5 text-[var(--cs-text-tertiary)]">{t("settings.agents.defaultCurrent", { name: definition.displayName })}</p> : null}
        </section>
        <AgentDetailSection title={t("settings.agents.details.installation")}>
        <div className="grid grid-cols-2 gap-4">
        <AgentDetail label={t("settings.agents.version")}>{formatAgentVersion(agent.version, definition.displayName) || t("settings.agents.unknown")}</AgentDetail>
        <AgentDetail label={t("settings.agents.updates.latestVersion")}><AgentVersionStatus agent={agent} /></AgentDetail>
        </div>
        <AgentDetail label={t("settings.agents.path")}>{agent.executablePath ? <div className="flex items-start gap-2 rounded-lg bg-[var(--cs-bg-hover)] p-3"><code className="min-w-0 flex-1 break-all text-xs leading-5">{agent.executablePath}</code><Button size="small" type="text" icon={<CopyOutlined />} aria-label={t("settings.agents.details.copyPath")} title={t("settings.agents.details.copyPath")} onClick={() => void copyPath()} /></div> : t("settings.agents.notFoundInPath")}</AgentDetail>
        <p className="m-0 text-xs text-[var(--cs-text-tertiary)]">{t("settings.agents.checkedAt", { time: new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: "medium", timeStyle: "medium" }).format(agent.checkedAt) })}</p>
        {agent.error ? <AgentDetail label={t("settings.agents.versionError")}><span className="break-words text-[var(--cs-danger)]">{agent.error}</span></AgentDetail> : null}
        </AgentDetailSection>
        <AgentDetailSection title={t("settings.agents.details.quota")}>
          {agent.id === "pi" ? <Muted>{t("settings.agents.quota.unsupported")}</Muted> : agent.id === "antigravity" ? <AntigravityQuotaDetails usage={quota as AntigravityUsage | null} loading={quotaLoading} /> : <AgentQuota agent={agent} quota={quota} loading={quotaLoading} expanded />}
        </AgentDetailSection>
        <AgentDetailSection title={t("settings.agents.details.installCommands")}>
          {definition.installCommands.map(({ command, shell }) => <div key={shell} className="rounded-lg bg-[var(--cs-bg-hover)] p-3">
            <div className="mb-2 flex items-center justify-between gap-2"><span className="text-xs font-medium text-[var(--cs-text-tertiary)]">{shell}</span><Button size="small" type="text" icon={<CopyOutlined />} onClick={() => onCopyInstall(command, shell)}>{t("common.copy")}</Button></div>
            <code className="block break-all text-xs leading-5 text-[var(--cs-text-secondary)]">{command}</code>
          </div>)}
          <p className="m-0 text-xs leading-5 text-[var(--cs-text-tertiary)]">{t("settings.agents.details.commandHint")}</p>
        </AgentDetailSection>
      </div> : null}
    </Drawer>
  );
}

function AgentDetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="space-y-4 rounded-xl border border-[var(--cs-border-card)] p-4"><h3 className="m-0 text-sm font-semibold text-[var(--cs-text-primary)]">{title}</h3>{children}</section>;
}

function AntigravityQuotaDetails({ usage, loading }: { usage: AntigravityUsage | null; loading: boolean }) {
  const { t } = useTranslation();
  if (loading && (!usage || usage.status !== "ok")) return <Muted>{t("settings.agents.quota.loading")}</Muted>;
  if (usage?.status !== "ok" || usage.windows.length === 0) return <QuotaUnavailable agentId="antigravity" />;

  const remaining = usage.windows.map((window) => clampPercent(window.remainingPercent));
  return (
    <div className="space-y-4">
      <QuotaDetailsHeader headline={quotaHeadline(Math.min(...remaining), t)} updatedAt={usage.updatedAt} />
      <div className="space-y-4">
        {usage.windows.map((window) => <AntigravityQuotaWindowDetail key={window.id} window={window} />)}
      </div>
    </div>
  );
}

function AntigravityQuotaWindowDetail({ window }: { window: AntigravityQuotaWindow }) {
  const { t } = useTranslation();
  const remaining = clampPercent(window.remainingPercent);
  const scope = window.scope === "Gemini" ? t("settings.agents.quota.gemini") : t("settings.agents.quota.claudeGpt");
  const period = window.window === "session" ? t("settings.agents.quota.sessionShort") : t("settings.agents.quota.weeklyShort");
  return <QuotaWindowDetail label={`${scope} · ${period}`} remaining={remaining} resetDescription={window.resetDescription} />;
}

function QuotaDetailsHeader({ headline, updatedAt }: { headline: string; updatedAt: number }) {
  const { t } = useTranslation();
  return <div className="flex flex-wrap items-center justify-between gap-3">
    <span className="text-sm font-semibold text-[var(--cs-text-primary)]">{headline}</span>
    <span className="text-xs text-[var(--cs-text-tertiary)]">{formatQuotaUpdatedAt(updatedAt, t)}</span>
  </div>;
}

function QuotaWindowDetail({ label, remaining, resetDescription }: { label: string; remaining: number; resetDescription?: string | null }) {
  const { t } = useTranslation();
  const color = remaining <= 5 ? "text-[var(--cs-danger)]" : remaining <= 20 ? "text-[var(--cs-warning)]" : "text-[var(--cs-success)]";
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium text-[var(--cs-text-primary)]">{label}</span>
        <span className="tabular-nums text-[var(--cs-text-secondary)]">{t("settings.agents.quota.remainingPercent", { value: remaining })}</span>
      </div>
      <progress className={`app-agent-quota-progress block h-1.5 w-full overflow-hidden rounded-full ${color}`}
        value={remaining} max={100} aria-label={label} />
      {resetDescription !== undefined && <div className="text-xs text-[var(--cs-text-tertiary)]">{formatQuotaReset(resetDescription, t)}</div>}
    </div>
  );
}

function AgentVersionStatus({ agent }: { agent: AgentCliInfo }) {
  const { t } = useTranslation();
  const check = useAgentVersionsStore((state) => state.versions[agent.id]);
  if (!check || check.status === "checking") return <span className="text-xs text-[var(--cs-text-tertiary)]" role="status">{t("settings.agents.updates.checking")}</span>;
  if (check.status === "error" || !check.latest) return <span className="text-xs text-[var(--cs-warning)]">{t("settings.agents.updates.failed")}</span>;
  const status = agent.installed ? compareAgentVersion(agent.version, check.latest) : "unknown";
  return <span className={`text-xs ${status === "updateAvailable" ? "font-medium text-[var(--cs-warning)]" : "text-[var(--cs-text-tertiary)]"}`}>
    {t(`settings.agents.updates.${status}`, { version: check.latest })}
  </span>;
}

function AgentDetail({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><div className="mb-1 text-xs" style={{ color: "var(--cs-text-tertiary)" }}>{label}</div><div className="text-sm" style={{ color: "var(--cs-text-secondary)" }}>{children}</div></div>;
}

function clampPercent(value: number) { return Math.max(0, Math.min(100, Math.round(value))); }
function formatNumber(value: number) { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value); }
function formatQuotaReset(resetDescription: string | null, t: ReturnType<typeof useTranslation>["t"]) {
  const reset = resetDescription ? new Date(resetDescription) : null;
  return reset && Number.isFinite(reset.getTime())
    ? t("statusBar.codexUsage.resetsAt", { time: reset.toLocaleString() })
    : t("statusBar.codexUsage.resetUnknown");
}
function formatQuotaUpdatedAt(updatedAt: number, t: ReturnType<typeof useTranslation>["t"]) {
  if (updatedAt <= 0) return t("statusBar.antigravityUsage.pending");
  const minutes = Math.floor(Math.max(0, Date.now() - updatedAt) / 60_000);
  if (minutes < 1) return t("statusBar.codexUsage.updatedNow");
  if (minutes < 60) return t("statusBar.codexUsage.updatedMinutes", { minutes });
  return t("statusBar.codexUsage.updatedHours", { hours: Math.floor(minutes / 60) });
}
function quotaHeadline(remaining: number, t: ReturnType<typeof useTranslation>["t"]) {
  if (remaining <= 5) return t("settings.agents.quota.exhausted");
  if (remaining <= 20) return t("settings.agents.quota.low");
  return t("settings.agents.quota.healthy");
}
