import { Button, Input, Spin, Tooltip } from "antd";
import { ApiOutlined, CloudServerOutlined, CodeOutlined, DeleteOutlined, EditOutlined, FolderOpenOutlined, GlobalOutlined, InfoCircleOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
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
  const text = (key: string) => t(`settings.mcpServers.${key}`);
  const threeScopes = props.agent === "claude" || props.agent === "qoder";
  const scopes: McpServerInfo["scope"][] = threeScopes ? ["local", "project", "user"] : ["workspace", "user"];
  const scopeLabel = (scope: McpServerInfo["scope"]) => text(`${scope}Servers`);
  const scopeDetail = (scope: McpServerInfo["scope"]) => text(scope === "local" ? "localScopeHint" : scope === "user" ? "userScopeHint" : "projectScopeHint");
  const scopeCount = props.servers.filter((server) => server.scope === props.scope).length;
  const disabled = props.loading || props.refreshing || !props.available;

  return (
    <section className="app-mcp" aria-label={text("title")}>
      <header className="app-mcp-header">
        <div className="app-mcp-heading">
          <span className="app-mcp-heading-icon"><ApiOutlined /></span>
          <div><h2>{text("title")}</h2><p>{text("overviewDesc")}</p></div>
        </div>
        <Button type="primary" icon={<PlusOutlined />} disabled={disabled} onClick={props.onAdd}>{text("addServer")}</Button>
      </header>

      <nav className="app-mcp-agents" aria-label={text("selectAgent")}>
        {props.agents.map((agent) => (
          <button key={agent} type="button" className="app-mcp-agent" aria-pressed={props.agent === agent}
            onClick={() => props.onAgent(agent)}>
            <AgentIcon agentId={agent} size={18} /><span>{AGENT_DEFINITIONS[agent].displayName}</span>
          </button>
        ))}
      </nav>

      <div className="app-mcp-layout">
        <aside className="app-mcp-sidebar">
          <h3>{text("scopeTitle")}</h3>
          <div className="app-mcp-scopes">
            {scopes.map((scope) => (
              <button type="button" className="app-mcp-scope" key={scope} aria-pressed={props.scope === scope}
                disabled={scope !== "user" && !props.projectName} onClick={() => props.onScope(scope)}>
                <span className="app-mcp-scope-top">{scope === "user" ? <GlobalOutlined /> : <FolderOpenOutlined />}
                  <strong>{scopeLabel(scope)}</strong><span className="app-mcp-count">{props.servers.filter((server) => server.scope === scope).length}</span>
                </span>
                <span className="app-mcp-scope-hint">{scopeDetail(scope)}</span>
              </button>
            ))}
          </div>
          <div className="app-mcp-context"><span>{text("currentProject")}</span><strong>{props.projectName || text("noProject")}</strong></div>
          <details className="app-mcp-config" key={`${props.agent}:${props.scope}`}>
            <summary>{text("configFile")}</summary>
            <p>{text("configHint")}</p>
            <code>{props.configPath || text("workspaceConfigUnavailable")}</code>
            {props.configPath && <Button size="small" icon={<FolderOpenOutlined />} onClick={props.onOpenConfig}>{text("openConfigFile")}</Button>}
          </details>
        </aside>

        <div className="app-mcp-main" aria-busy={props.loading || props.refreshing}>
          <div className="app-mcp-list-heading"><div><h3>{scopeLabel(props.scope)} <span className="app-mcp-count">{scopeCount}</span></h3>
            <p>{scopeDetail(props.scope)}</p></div>
            <Tooltip title={text("refreshList")}><Button icon={<ReloadOutlined />} loading={props.loading || props.refreshing}
              aria-label={text("refreshList")} onClick={props.onRefresh} /></Tooltip>
          </div>
          <Input prefix={<SearchOutlined />} placeholder={text("searchPlaceholder")} aria-label={text("searchPlaceholder")}
            value={props.search} onChange={(event) => props.onSearch(event.target.value)} allowClear />

          <div className="app-mcp-server-list">
            {props.loading ? <div className="app-mcp-empty"><Spin /></div> : !props.available ? (
              <div className="app-mcp-empty"><InfoCircleOutlined /><h3>{text("loadFailed")}</h3><Button onClick={props.onRefresh}>{text("refreshList")}</Button></div>
            ) : props.filteredServers.length === 0 ? (
              <div className="app-mcp-empty"><CloudServerOutlined /><h3>{text(props.search ? "emptyFiltered" : "emptyInitial")}</h3>
                <p>{text(props.search ? "emptyFilteredDetail" : "emptyInitialDetail")}</p>
                {props.search ? <Button onClick={() => props.onSearch("")}>{text("clearSearch")}</Button>
                  : <Button type="primary" icon={<PlusOutlined />} onClick={props.onAdd}>{text("addServer")}</Button>}
              </div>
            ) : props.filteredServers.map((server) => {
              const key = `${server.scope}:${server.name}`;
              const remote = server.serverType !== "stdio";
              const result = props.testResult?.name === key ? props.testResult : null;
              const testing = props.testingKey === key;
              return (
                <article className="app-mcp-server" key={key}>
                  <div className="app-mcp-server-top"><span className="app-mcp-server-icon">{remote ? <CloudServerOutlined /> : <CodeOutlined />}</span>
                    <div className="app-mcp-server-name"><h4 title={server.name}>{server.name}</h4>
                      <span>{text(remote ? "remoteService" : "localProcess")}</span></div>
                    <span className="app-mcp-transport">{server.serverType.toUpperCase()}</span>
                  </div>
                  <code className="app-mcp-endpoint">{remote ? server.url : server.command}</code>
                  <div className="app-mcp-server-footer">
                    <span className="app-mcp-check-state" data-result={result ? (result.success ? "success" : "error") : "unknown"} role="status">
                      <span className="app-mcp-status-dot" />{text(testing ? "checking" : result ? (result.success ? "basicPassed" : "basicFailed") : "notChecked")}
                    </span>
                    <div className="app-mcp-actions">
                      <Button size="small" icon={<ApiOutlined />} loading={testing} disabled={disabled || !!props.testingKey} onClick={() => props.onTest(server)}>{text("basicCheck")}</Button>
                      <Button size="small" icon={<EditOutlined />} disabled={disabled} onClick={() => props.onEdit(server)}>{text("editServer")}</Button>
                      <Tooltip title={text("deleteServer")}><Button size="small" type="text" danger icon={<DeleteOutlined />} disabled={disabled}
                        aria-label={`${text("deleteServer")} ${server.name}`} onClick={() => props.onDelete(server)} /></Tooltip>
                    </div>
                  </div>
                  {result && <div className="app-mcp-test-detail" role="status">{result.message}</div>}
                  {(server.args.length > 0 || Object.keys(server.env).length > 0 || Object.keys(server.headers).length > 0 || server.cwd) && (
                    <details className="app-mcp-server-details"><summary>{text("connectionDetails")}</summary>
                      <dl>{server.args.length > 0 && <><dt>{text("args")}</dt><dd><code>{server.args.join("\n")}</code></dd></>}
                        {server.cwd && <><dt>{text("cwd")}</dt><dd><code>{server.cwd}</code></dd></>}
                        {Object.keys(server.env).length > 0 && <><dt>{text("env")}</dt><dd>{Object.keys(server.env).join(", ")}</dd></>}
                        {Object.keys(server.headers).length > 0 && <><dt>{text("headers")}</dt><dd>{Object.keys(server.headers).join(", ")}</dd></>}
                      </dl>
                    </details>
                  )}
                </article>
              );
            })}
          </div>
          <p className="app-mcp-footnote"><InfoCircleOutlined /><span>{text("checkHint")}</span></p>
        </div>
      </div>
    </section>
  );
}
