import { SettingsPageHeader } from "./SettingsPageHeader";
import { SettingsDisclosure, SettingsSection } from "./SettingsSection";
import { Button, Empty, Input, Spin, Tag, Tooltip } from "antd";
import {
  ApiOutlined,
  CloudServerOutlined,
  CodeOutlined,
  DeleteOutlined,
  EditOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { AgentIcon } from "@/components/AgentIcon";
import { AGENT_DEFINITIONS } from "@/lib/agents";
import type { AiAgentId, McpServerInfo } from "@/types";
import "./mcpServers.css";

interface McpServersViewProps {
  agents: AiAgentId[];
  agent: AiAgentId;
  scope: McpServerInfo["scope"];
  servers: McpServerInfo[];
  filteredServers: McpServerInfo[];
  projectName?: string;
  configPath?: string | null;
  search: string;
  loading: boolean;
  refreshing: boolean;
  available: boolean;
  testingKey: string | null;
  testResult: { name: string; success: boolean; message: string } | null;
  onAgent: (agent: AiAgentId) => void;
  onScope: (scope: McpServerInfo["scope"]) => void;
  onSearch: (value: string) => void;
  onRefresh: () => void;
  onAdd: () => void;
  onEdit: (server: McpServerInfo) => void;
  onDelete: (server: McpServerInfo) => void;
  onTest: (server: McpServerInfo) => void;
  onOpenConfig: () => void;
}

export function McpServersView(props: McpServersViewProps) {
  const { t } = useTranslation();
  const text = (key: string, options?: Record<string, unknown>) =>
    t(`settings.mcpServers.${key}`, options);
  const threeScopes = props.agent === "claude" || props.agent === "qoder";
  const scopes: McpServerInfo["scope"][] = threeScopes
    ? ["local", "project", "user"]
    : ["workspace", "user"];
  const scopeLabel = (scope: McpServerInfo["scope"]) => text(`${scope}Servers`);
  const scopeHint = (scope: McpServerInfo["scope"]) => {
    if (scope === "local") return text("localScopeHint");
    if (scope === "project" || scope === "workspace") return text("projectScopeHint");
    return text("userScopeHint");
  };
  const disabled = props.loading || props.refreshing || !props.available;
  const hasSearch = Boolean(props.search.trim());
  const needsProject = props.scope !== "user" && !props.projectName;

  return (
    <section aria-label={text("title")}>
      <SettingsPageHeader
        title={text("title")}
        description={text("headerDesc", {
          agent: AGENT_DEFINITIONS[props.agent].displayName,
        })}
        actions={
          <>
            <Button
              icon={<ReloadOutlined spin={props.refreshing} />}
              disabled={props.loading}
              aria-label={text("refreshList")}
              onClick={props.onRefresh}
            >
              {t("common.refresh")}
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={disabled || needsProject}
              onClick={props.onAdd}
            >
              {text("addServer")}
            </Button>
          </>
        }
      >
        <div
          className="app-settings-choices"
          role="group"
          aria-label={text("selectAgent")}
        >
          {props.agents.map((agent) => (
            <button
              key={agent}
              type="button"
              aria-pressed={props.agent === agent}
              onClick={() => props.onAgent(agent)}
            >
              <AgentIcon agentId={agent} size={14} />
              <span>{AGENT_DEFINITIONS[agent].displayName}</span>
            </button>
          ))}
        </div>

        <div className="app-settings-scope-tabs" role="group" aria-label={text("scopeTitle")}>
          {scopes.map((scope) => {
            const count = props.servers.filter((server) => server.scope === scope).length;
            const scopeDisabled = scope !== "user" && !props.projectName;
            return (
              <button
                key={scope}
                type="button"
                aria-pressed={props.scope === scope}
                disabled={scopeDisabled}
                title={scopeDisabled ? text("openProjectFirst") : scopeHint(scope)}
                onClick={() => props.onScope(scope)}
              >
                {scopeLabel(scope)}
                <span>{count}</span>
              </button>
            );
          })}
        </div>
      </SettingsPageHeader>

      <div className="mb-4 flex flex-wrap gap-3">
        <Input
          className="min-w-48 flex-1"
          allowClear
          prefix={<SearchOutlined className="text-[var(--cs-text-tertiary)]" />}
          placeholder={text("searchPlaceholder")}
          aria-label={text("searchPlaceholder")}
          value={props.search}
          onChange={(event) => props.onSearch(event.target.value)}
        />
      </div>

      {props.loading ? (
        <div className="flex justify-center py-20" aria-busy="true">
          <Spin />
        </div>
      ) : (
        <SettingsSection
          title={`${scopeLabel(props.scope)} (${props.filteredServers.length})`}
          description={
            props.scope === "user"
              ? scopeHint(props.scope)
              : `${text("currentProject")}：${props.projectName || text("noProject")} · ${scopeHint(props.scope)}`
          }
        >
          <div className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="text-[11px] font-mono break-all text-[var(--cs-text-tertiary)]">
                {props.configPath || text("workspaceConfigUnavailable")}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="small"
                icon={<FolderOpenOutlined />}
                disabled={!props.configPath}
                onClick={props.onOpenConfig}
              >
                {text("openConfigFile")}
              </Button>
            </div>
          </div>

          {!props.available ? (
            <Empty description={text("loadFailed")} className="py-7">
              <Button onClick={props.onRefresh}>{text("refreshList")}</Button>
            </Empty>
          ) : props.filteredServers.length === 0 ? (
            <Empty
              description={
                needsProject
                  ? text("openProjectFirst")
                  : text(hasSearch ? "emptyFiltered" : "emptyInitial")
              }
              className="py-7"
            >
              <div className="text-xs mb-4 text-[var(--cs-text-tertiary)]">
                {needsProject
                  ? text("projectServersDetail")
                  : text(hasSearch ? "emptyFilteredDetail" : "emptyInitialDetail")}
              </div>
              {hasSearch ? (
                <Button onClick={() => props.onSearch("")}>{text("clearSearch")}</Button>
              ) : !needsProject ? (
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  disabled={disabled}
                  onClick={props.onAdd}
                >
                  {text("addServer")}
                </Button>
              ) : null}
            </Empty>
          ) : (
            <div className="app-settings-list" aria-busy={props.refreshing}>
              {props.filteredServers.map((server) => {
                const key = `${server.scope}:${server.name}`;
                const remote = server.serverType !== "stdio";
                const result = props.testResult?.name === key ? props.testResult : null;
                const testing = props.testingKey === key;
                const hasDetails =
                  server.args.length > 0 ||
                  Object.keys(server.env).length > 0 ||
                  Object.keys(server.headers).length > 0 ||
                  Boolean(server.cwd);
                const endpointPreview = remote
                  ? server.url
                  : [server.command, ...server.args].filter(Boolean).join(" ");

                return (
                  <article key={key} className="app-mcp-row">
                    <div className="app-settings-resource-row">
                      <div className="app-settings-resource-row__open">
                        <div className="app-settings-resource-row__name">
                          {remote ? (
                            <CloudServerOutlined className="text-[14px] text-[var(--cs-primary)]" />
                          ) : (
                            <CodeOutlined className="text-[14px] text-[var(--cs-primary)]" />
                          )}
                          <span
                            className="text-sm font-medium text-[var(--cs-text-primary)]"
                            title={server.name}
                          >
                            {server.name}
                          </span>
                          <Tag className="!m-0" color={remote ? "cyan" : "purple"}>
                            {server.serverType.toUpperCase()}
                          </Tag>
                          <Tag className="!m-0">
                            {text(remote ? "remoteService" : "localProcess")}
                          </Tag>
                          <span
                            className="app-mcp-check-state"
                            data-result={
                              result ? (result.success ? "success" : "error") : "unknown"
                            }
                            role="status"
                          >
                            <span className="app-mcp-status-dot" />
                            {text(
                              testing
                                ? "checking"
                                : result
                                  ? result.success
                                    ? "basicPassed"
                                    : "basicFailed"
                                  : "notChecked"
                            )}
                          </span>
                        </div>
                        <div className="app-settings-resource-row__summary font-mono">
                          {endpointPreview}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 flex-wrap shrink-0">
                        <Button
                          size="small"
                          icon={<ApiOutlined />}
                          loading={testing}
                          disabled={disabled || Boolean(props.testingKey)}
                          onClick={() => props.onTest(server)}
                        >
                          {text("basicCheck")}
                        </Button>
                        <Button
                          size="small"
                          icon={<EditOutlined />}
                          disabled={disabled}
                          onClick={() => props.onEdit(server)}
                        >
                          {text("editServer")}
                        </Button>
                        <Tooltip title={text("deleteServer")}>
                          <Button
                            size="small"
                            type="text"
                            danger
                            icon={<DeleteOutlined />}
                            disabled={disabled}
                            aria-label={`${text("deleteServer")} ${server.name}`}
                            onClick={() => props.onDelete(server)}
                          />
                        </Tooltip>
                      </div>
                    </div>

                    {(result || hasDetails) && (
                      <div className="px-2 pb-3 space-y-2">
                        {result && (
                          <div className="app-mcp-test-detail" role="status">
                            {result.message}
                          </div>
                        )}
                        {hasDetails && (
                          <SettingsDisclosure title={text("connectionDetails")}>
                            <dl className="app-mcp-details-grid">
                              {server.args.length > 0 && (
                                <>
                                  <dt>{text("args")}</dt>
                                  <dd>
                                    <code>{server.args.join("\n")}</code>
                                  </dd>
                                </>
                              )}
                              {server.cwd && (
                                <>
                                  <dt>{text("cwd")}</dt>
                                  <dd>
                                    <code>{server.cwd}</code>
                                  </dd>
                                </>
                              )}
                              {Object.keys(server.env).length > 0 && (
                                <>
                                  <dt>{text("env")}</dt>
                                  <dd>{Object.keys(server.env).join(", ")}</dd>
                                </>
                              )}
                              {Object.keys(server.headers).length > 0 && (
                                <>
                                  <dt>{text("headers")}</dt>
                                  <dd>{Object.keys(server.headers).join(", ")}</dd>
                                </>
                              )}
                            </dl>
                          </SettingsDisclosure>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </SettingsSection>
      )}
    </section>
  );
}
