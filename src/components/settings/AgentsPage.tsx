import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  CodeOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { Button, Spin, Tag, Tooltip, message } from "antd";
import { useTranslation } from "react-i18next";
import { inspectAgentClis } from "@/lib/api";
import {
  AGENT_DEFINITIONS,
  AI_AGENT_ORDER,
  formatAgentVersion,
} from "@/lib/agents";
import type { AgentCliInfo } from "@/types";
import { AgentIcon } from "@/components/AgentIcon";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import { useAppStore } from "@/store";


export function AgentsPage() {
  const { t, i18n } = useTranslation();
  const defaultAgentId = useAppStore((state) => state.defaultAgentId);
  const setDefaultAgentId = useAppStore((state) => state.setDefaultAgentId);
  const [agents, setAgents] = useState<AgentCliInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (showSuccess = false) => {
    setLoading(true);
    try {
      const result = await inspectAgentClis({ forceRefresh: showSuccess });
      setAgents([...result].sort(
        (left, right) =>
          AI_AGENT_ORDER.indexOf(left.id) - AI_AGENT_ORDER.indexOf(right.id),
      ));
      if (showSuccess) message.success(t("settings.agents.refreshSuccess"));
    } catch (error) {
      console.error("Failed to inspect agent CLIs:", error);
      message.error(t("settings.agents.refreshFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installedCount = useMemo(
    () => agents.filter((agent) => agent.installed).length,
    [agents],
  );
  const checkedAt = agents[0]?.checkedAt;
  const defaultAgent = agents.find((agent) => agent.id === defaultAgentId) ?? null;

  const selectDefaultAgent = useCallback((agent: AgentCliInfo) => {
    if (!agent.installed) return;
    setDefaultAgentId(agent.id);
    message.success(t("settings.agents.defaultChanged", {
      name: AGENT_DEFINITIONS[agent.id].displayName,
    }));
  }, [setDefaultAgentId, t]);

  return (
    <div className="mx-auto max-w-5xl">
      <SettingsPageHeader
        title={t("settings.agents.title")}
        description={t("settings.agents.subtitle")}
        actions={
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh(true)}>
            {t("settings.agents.refresh")}
          </Button>
        }
      />

      <div
        className="app-glass-card mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3"
        style={{ background: "var(--cs-bg-card)", border: "1px solid var(--cs-border-card)" }}
      >
        <div className="flex items-center gap-2 text-sm" style={{ color: "var(--cs-text-secondary)" }}>
          <CodeOutlined style={{ color: "var(--cs-primary)" }} />
          <span>{t("settings.agents.summary", {
            installed: installedCount,
            total: agents.length || AI_AGENT_ORDER.length,
          })}</span>
        </div>
        {checkedAt && (
          <span className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
            {t("settings.agents.checkedAt", {
              time: new Intl.DateTimeFormat(i18n.resolvedLanguage, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              }).format(checkedAt),
            })}
          </span>
        )}
      </div>

      <div
        className="app-glass-card mb-4 rounded-xl px-4 py-3"
        style={{ background: "var(--cs-bg-card)", border: "1px solid var(--cs-border-card)" }}
      >
        <div className="text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>
          {t("settings.agents.defaultTitle")}
        </div>
        <div className="mt-1 text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
          {defaultAgent?.installed
            ? t("settings.agents.defaultCurrent", {
                name: AGENT_DEFINITIONS[defaultAgent.id].displayName,
              })
            : defaultAgentId
              ? t("settings.agents.defaultUnavailable")
              : t("settings.agents.defaultMissing")}
        </div>
      </div>

      {loading && agents.length === 0 ? (
        <div className="flex min-h-64 items-center justify-center"><Spin /></div>
      ) : (
        <div
          className="grid gap-4"
          style={{
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
          }}
        >
          {agents.map((agent) => {
            const definition = AGENT_DEFINITIONS[agent.id];
            return (
              <div
                key={agent.id}
                className="app-glass-card min-w-0 rounded-xl p-5"
                style={{
                  background: "var(--cs-bg-card)",
                  border: "1px solid var(--cs-border-card)",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
                }}
              >
                <div className="mb-5 flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <div
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-lg font-bold text-white"
                      style={{
                        background: `${definition.brandColor}16`,
                        border: `1px solid ${definition.brandColor}32`,
                      }}
                    >
                      <AgentIcon agentId={agent.id} size={25} />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-base font-semibold" style={{ color: "var(--cs-text-primary)" }}>
                        {definition.displayName}
                      </div>
                      <code className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
                        {definition.command}
                      </code>
                    </div>
                  </div>
                  <Tag
                    icon={agent.installed ? <CheckCircleFilled /> : <CloseCircleFilled />}
                    color={agent.installed ? "success" : "default"}
                    className="m-0 shrink-0"
                  >
                    {t(agent.installed ? "settings.agents.installed" : "settings.agents.notInstalled")}
                  </Tag>
                </div>

                <div className="space-y-4">
                  <AgentDetail label={t("settings.agents.version")}>
                    {formatAgentVersion(agent.version, definition.displayName) || t("settings.agents.unknown")}
                  </AgentDetail>
                  <AgentDetail label={t("settings.agents.path")}>
                    {agent.executablePath ? (
                      <Tooltip title={agent.executablePath} placement="bottomLeft">
                        <div className="truncate font-mono text-[11px]">{agent.executablePath}</div>
                      </Tooltip>
                    ) : t("settings.agents.notFoundInPath")}
                  </AgentDetail>
                </div>


                {agent.error && (
                  <Tooltip title={agent.error}>
                    <div
                      className="mt-4 truncate rounded-lg px-3 py-2 text-[11px]"
                      style={{ background: "var(--cs-danger-hover)", color: "var(--cs-danger)" }}
                    >
                      {t("settings.agents.versionError")}: {agent.error}
                    </div>
                  </Tooltip>
                )}

                <Button
                  block
                  className="mt-4"
                  type={defaultAgentId === agent.id ? "primary" : "default"}
                  disabled={!agent.installed || defaultAgentId === agent.id}
                  onClick={() => selectDefaultAgent(agent)}
                >
                  {t(defaultAgentId === agent.id
                    ? "settings.agents.defaultActive"
                    : "settings.agents.setDefault")}
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-5 text-xs leading-5" style={{ color: "var(--cs-text-tertiary)" }}>
        {t("settings.agents.pathHint")}
      </div>
    </div>
  );
}

function AgentDetail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px]" style={{ color: "var(--cs-text-tertiary)" }}>{label}</div>
      <div className="truncate text-sm" style={{ color: "var(--cs-text-secondary)" }}>{children}</div>
    </div>
  );
}
