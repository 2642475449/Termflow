import { useEffect, useId } from "react";
import { Button, Input, Modal, Select, Spin, message } from "antd";
import { CloudServerOutlined, CodeOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, StopOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { AgentIcon } from "@/components/AgentIcon";
import { openExternalUrl } from "@/lib/api";
import { isRemoteConnectionBusy, REMOTE_AGENT_SETUP, remoteErrorText, type RemoteAgentId, type RemoteHost } from "@/lib/remote";
import {
  connectRemoteWorkspace, disconnectRemoteWorkspace, forgetRemoteSession, manageRemoteServer, refreshRemoteHosts,
  refreshRemoteRuntime, removeRemoteHost, saveRemoteHostDraft, startRemoteSession,
  startRemoteWorkspacePolling, stopRemoteSession, useRemoteWorkspaceStore,
} from "@/store/slices/remoteWorkspace";
import { RemoteAuthenticationTerminal, RemoteTerminal } from "./RemoteTerminal";
import "./remoteWorkspace.css";

function RemoteErrorMessage({ error }: { error: string }) {
  const { t } = useTranslation();
  const readable = remoteErrorText(error);
  return <>
    <span>{readable.startsWith("remote.") ? t(readable) : readable}</span>
    {readable !== error && !error.startsWith("remote.errors.") && <details className="app-remote-diagnostic"><summary>{t("remote.errors.diagnostic")}</summary><pre>{error}</pre></details>}
  </>;
}

function RemoteHostEditor() {
  const { t } = useTranslation();
  const id = useId();
  const open = useRemoteWorkspaceStore((state) => state.editorOpen);
  const draft = useRemoteWorkspaceStore((state) => state.hostDraft);
  const pending = useRemoteWorkspaceStore((state) => state.pendingActions.save);
  const error = useRemoteWorkspaceStore((state) => state.errors.editor);
  const setDraft = useRemoteWorkspaceStore((state) => state.setHostDraft);
  const setEditor = useRemoteWorkspaceStore((state) => state.setHostEditor);
  const save = async () => {
    useRemoteWorkspaceStore.getState().setError("editor", null);
    try { await saveRemoteHostDraft(); }
    catch (failure) { useRemoteWorkspaceStore.getState().setError("editor", remoteErrorText(failure)); }
  };
  return (
    <Modal
      open={open} title={t(draft.id ? "remote.host.edit" : "remote.host.add")}
      onCancel={() => { if (!pending) setEditor(false); }}
      onOk={() => void save()} confirmLoading={pending}
      okText={t("common.save")} cancelText={t("common.cancel")}
      mask={{ closable: false }} className="app-remote-host-modal"
    >
      <div className="app-remote-host-form">
        <p className="app-remote-muted">{t("remote.host.intro")}</p>
        <label htmlFor={`${id}-name`}>{t("remote.host.name")}</label>
        <Input id={`${id}-name`} autoFocus value={draft.name} maxLength={120} onChange={(event) => setDraft({ name: event.target.value })} />
        <label htmlFor={`${id}-target`}>{t("remote.host.target")}</label>
        <Input id={`${id}-target`} value={draft.target} placeholder={t("remote.host.targetPlaceholder")} onChange={(event) => setDraft({ target: event.target.value })} />
        <p className="app-remote-field-help">{t("remote.host.targetHelp")}</p>
        <div className="app-remote-host-form__advanced">
          <div>
            <label htmlFor={`${id}-port`}>{t("remote.host.port")}</label>
            <Input id={`${id}-port`} value={draft.port} inputMode="numeric" placeholder={t("remote.host.configDefault")} onChange={(event) => setDraft({ port: event.target.value })} />
          </div>
          <div>
            <label htmlFor={`${id}-identity`}>{t("remote.host.identity")}</label>
            <Input id={`${id}-identity`} value={draft.identityFile} placeholder={t("remote.host.identityPlaceholder")} onChange={(event) => setDraft({ identityFile: event.target.value })} />
          </div>
        </div>
        {error && <div role="alert" className="app-remote-error"><RemoteErrorMessage error={error} /></div>}
      </div>
    </Modal>
  );
}

export function RemoteWorkspacePanel() {
  const { t } = useTranslation();
  const id = useId();
  const visible = useRemoteWorkspaceStore((state) => state.visible);
  const loading = useRemoteWorkspaceStore((state) => state.loading);
  const hosts = useRemoteWorkspaceStore((state) => state.hosts);
  const selectedHostId = useRemoteWorkspaceStore((state) => state.selectedHostId);
  const connections = useRemoteWorkspaceStore((state) => state.connections);
  const inspections = useRemoteWorkspaceStore((state) => state.inspections);
  const sessionsByHost = useRemoteWorkspaceStore((state) => state.sessionsByHost);
  const selectedSessionByHost = useRemoteWorkspaceStore((state) => state.selectedSessionByHost);
  const errors = useRemoteWorkspaceStore((state) => state.errors);
  const pending = useRemoteWorkspaceStore((state) => state.pendingActions);
  const reconnectAttempts = useRemoteWorkspaceStore((state) => state.reconnectAttempts);
  const pendingStop = useRemoteWorkspaceStore((state) => state.pendingStop);
  const pendingServerAction = useRemoteWorkspaceStore((state) => state.pendingServerAction);
  const cwd = useRemoteWorkspaceStore((state) => state.cwd);
  const agentId = useRemoteWorkspaceStore((state) => state.agentId);
  const host = hosts.find((item) => item.id === selectedHostId);
  const connection = host ? connections[host.id] : undefined;
  const inspection = host ? inspections[host.id] : undefined;
  const sessions = host ? sessionsByHost[host.id] ?? [] : [];
  const selectedSession = sessions.find((session) => session.id === (host ? selectedSessionByHost[host.id] : null));
  const connected = connection?.state === "connected";
  const busy = isRemoteConnectionBusy(connection);
  const error = (host && errors[host.id]) || connection?.error || errors.global;
  const chosenAgent = inspection?.agents.find((agent) => agent.id === agentId);
  const reconnecting = host ? (reconnectAttempts[host.id] ?? 0) > 0 : false;
  const pendingSessionAction = pendingStop?.action ?? "stop";
  const connectionLabel = (hostId: string) => (reconnectAttempts[hostId] ?? 0) > 0 && !isRemoteConnectionBusy(connections[hostId]) && connections[hostId]?.state !== "connected"
    ? t("remote.connection.reconnecting", { attempt: reconnectAttempts[hostId] })
    : t(`remote.connection.${connections[hostId]?.state ?? "disconnected"}`);

  useEffect(() => {
    if (visible) void refreshRemoteHosts().catch(() => undefined);
  }, [visible]);
  useEffect(() => startRemoteWorkspacePolling(), []);

  const run = async (operation: () => Promise<unknown>, hostId = host?.id ?? "global") => {
    useRemoteWorkspaceStore.getState().setError(hostId, null);
    try { await operation(); }
    catch (failure) { useRemoteWorkspaceStore.getState().setError(hostId, remoteErrorText(failure)); }
  };
  const editHost = (value: RemoteHost | null) => {
    useRemoteWorkspaceStore.getState().setError("editor", null);
    useRemoteWorkspaceStore.getState().setHostEditor(value);
  };
  const openGuide = (agent: "codex" | "claude") => run(() => openExternalUrl(REMOTE_AGENT_SETUP[agent].url));
  const copySetup = (agent: "codex" | "claude", command: "install" | "login") => run(async () => {
    await navigator.clipboard.writeText(REMOTE_AGENT_SETUP[agent][command]);
    message.success(t("remote.environment.commandCopied"));
  });

  return (
    <>
      <Modal
        open={visible} onCancel={() => useRemoteWorkspaceStore.getState().setVisible(false)}
        title={<span className="app-remote-title"><CloudServerOutlined />{t("remote.title")}</span>}
        footer={null} width="calc(100vw - 48px)" className="app-remote-modal" centered
        destroyOnHidden={false} mask={{ closable: false }}
      >
        <div className="app-remote-workspace">
          <aside className="app-remote-hosts" aria-label={t("remote.host.list")}>
            <div className="app-remote-section-heading">
              <h2>{t("remote.host.list")}</h2>
              <div className="app-remote-actions">
                <Button size="small" type="text" icon={<ReloadOutlined />} loading={loading}
                  title={t("remote.host.refreshConfig")} aria-label={t("remote.host.refreshConfig")}
                  onClick={() => void run(refreshRemoteHosts, "global")} />
                <Button size="small" type="text" icon={<PlusOutlined />} aria-label={t("remote.host.add")} onClick={() => editHost(null)} />
              </div>
            </div>
            {loading ? <div className="app-remote-loading"><Spin size="small" /></div> : hosts.length === 0 ? (
              <div className="app-remote-host-empty">
                <p>{t("remote.host.empty")}</p>
                <Button size="small" onClick={() => editHost(null)}>{t("remote.host.add")}</Button>
              </div>
            ) : hosts.map((item) => (
              <button key={item.id} type="button" className="app-remote-host-row" aria-pressed={item.id === selectedHostId}
                onClick={() => useRemoteWorkspaceStore.getState().setSelectedHost(item.id)}>
                <span className="app-remote-host-row__name"><CloudServerOutlined />{item.name}</span>
                <span className="app-remote-host-row__target">{item.target}</span>
                {item.sshConfigFile && <span className="app-remote-host-row__source" title={item.sshConfigFile}>{t("remote.host.configSource")}</span>}
                <span className="app-remote-state" data-state={connections[item.id]?.state ?? "disconnected"}>
                  {connectionLabel(item.id)}
                </span>
              </button>
            ))}
            <p className="app-remote-hosts__note">{t("remote.host.scope")}</p>
          </aside>

          <main className="app-remote-main">
            {!host ? (
              <div className="app-remote-welcome">
                <CloudServerOutlined />
                <h1>{t("remote.welcome.title")}</h1>
                <p>{t("remote.welcome.description")}</p>
                {errors.global && <div className="app-remote-error" role="alert"><RemoteErrorMessage error={errors.global} /><Button type="link" onClick={() => void run(refreshRemoteHosts)}>{t("remote.refresh")}</Button></div>}
                <Button type="primary" icon={<PlusOutlined />} onClick={() => editHost(null)}>{t("remote.host.add")}</Button>
              </div>
            ) : (
              <>
                <header className="app-remote-connection-header">
                  <div className="app-remote-connection-header__identity">
                    <h1>{host.name}</h1>
                    <span className="app-remote-monospace">{host.target}{host.port ? `:${host.port}` : ""}</span>
                    <span className="app-remote-state" data-state={connection?.state ?? "disconnected"}>{connectionLabel(host.id)}</span>
                  </div>
                  <div className="app-remote-actions">
                    <Button size="small" type="text" icon={<EditOutlined />} disabled={!!host.sshConfigFile || connected || busy || reconnecting} title={host.sshConfigFile ? t("remote.host.configManaged") : undefined} aria-label={t("remote.host.edit")} onClick={() => editHost(host)} />
                    <Button size="small" type="text" icon={<DeleteOutlined />} disabled={!!host.sshConfigFile || connected || busy || reconnecting || pending[`${host.id}:delete`]} title={host.sshConfigFile ? t("remote.host.configManaged") : undefined} aria-label={t("remote.host.remove")} onClick={() => void run(() => removeRemoteHost(host.id))} />
                    {connected || busy || reconnecting ? (
                      <Button size="small" onClick={() => void run(() => disconnectRemoteWorkspace(host.id))}>{t(busy ? "remote.cancelConnection" : reconnecting ? "remote.cancelReconnect" : "remote.disconnect")}</Button>
                    ) : (
                      <Button size="small" type="primary" disabled={pending[`${host.id}:disconnect`]} loading={pending[`${host.id}:connect`]} onClick={() => void run(() => connectRemoteWorkspace(host.id))}>{t("remote.connect")}</Button>
                    )}
                  </div>
                </header>

                {error && <div role="alert" className="app-remote-error app-remote-error--banner"><RemoteErrorMessage error={error} /></div>}

                {(busy || (connection?.state === "error" && connection.authOutput)) && (
                  <section className="app-remote-auth" aria-label={t("remote.authentication.title")}>
                    <div className="app-remote-section-heading"><h2>{t("remote.authentication.title")}</h2>{busy && <Spin size="small" />}</div>
                    <p className="app-remote-muted">{t("remote.authentication.help")}</p>
                    <RemoteAuthenticationTerminal hostId={host.id} active={visible} />
                    <p className="app-remote-field-help">{t("remote.authentication.install")}</p>
                  </section>
                )}

                {connected && (
                  <>
                  <details className="app-remote-environment" open={!selectedSession && (!inspection || inspection.agents.some((agent) => !agent.installed || agent.authStatus !== "authenticated"))}>
                    <summary>{t("remote.environment.title")}<span className="app-remote-muted" title={connection.server?.root}>{t("remote.environment.serverVersion", { version: connection.server?.version ?? inspection?.helperVersion ?? "—" })}</span></summary>
                    <div className="app-remote-environment__content">
                      <p className="app-remote-muted">{t("remote.environment.intro")}</p>
                      {inspection ? inspection.agents.map((agent) => (
                        <div key={agent.id} className="app-remote-agent-setup">
                        <div className="app-remote-agent-row">
                          <span className="app-remote-agent-row__name"><AgentIcon agentId={agent.id} size={18} />{agent.id === "codex" ? "Codex" : "Claude Code"}</span>
                          <span>{agent.installed ? agent.version || t("remote.environment.installed") : t("remote.environment.notInstalled")}</span>
                          <span className="app-remote-muted">{t(`remote.auth.${agent.authStatus}`)}</span>
                          <Button size="small" type="link" onClick={() => void openGuide(agent.id)}>{t("remote.environment.guide")}</Button>
                        </div>
                        <div className="app-remote-agent-setup__actions">
                          {!agent.installed && <Button type="text" size="small" onClick={() => void copySetup(agent.id, "install")}>{t("remote.environment.copyInstall")}</Button>}
                          <Button type="text" size="small" onClick={() => void copySetup(agent.id, "login")}>{t("remote.environment.copyLogin")}</Button>
                          <span className="app-remote-muted">{t(`remote.hook.${agent.hookStatus}`)}</span>
                        </div>
                        {agent.id === "codex" && agent.installed && agent.hookStatus === "pending" && <p className="app-remote-field-help">{t("remote.hook.codexPending")}</p>}
                        </div>
                      )) : <Spin size="small" />}
                    </div>
                  </details>
                      <div className="app-remote-environment-actions">
                        <div className="app-remote-actions">
                          <Button size="small" icon={<CodeOutlined />} loading={pending[`${host.id}:launch`]} onClick={() => void run(() => startRemoteSession(host.id, "shell"))}>{t("remote.environment.openShell")}</Button>
                          <Button size="small" icon={<ReloadOutlined />} onClick={() => void run(() => refreshRemoteRuntime(host.id))}>{t("remote.refresh")}</Button>
                        </div>
                        <div className="app-remote-actions">
                          {connection.server?.root && <span className="app-remote-install-root" title={connection.server.root}>{connection.server.root}</span>}
                          <Button size="small" type="text" onClick={() => useRemoteWorkspaceStore.getState().setPendingServerAction({ hostId: host.id, action: "stop" })}>{t("remote.server.stop")}</Button>
                          <Button size="small" type="text" onClick={() => useRemoteWorkspaceStore.getState().setPendingServerAction({ hostId: host.id, action: "uninstall" })}>{t("remote.server.uninstall")}</Button>
                        </div>
                      </div>
                  </>
                )}

                <section className="app-remote-session-area" aria-label={t("remote.sessions.title")}>
                  <div className="app-remote-launch">
                    <label className="app-remote-sr-only" htmlFor={`${id}-cwd`}>{t("remote.sessions.directory")}</label>
                    <Input id={`${id}-cwd`} value={cwd} prefix={<CodeOutlined />} aria-label={t("remote.sessions.directory")}
                      placeholder={t("remote.sessions.directoryPlaceholder")} onChange={(event) => useRemoteWorkspaceStore.getState().setLaunchDirectory(event.target.value)} disabled={!connected} />
                    <Select<RemoteAgentId> value={agentId} aria-label={t("remote.sessions.agent")} disabled={!connected}
                      onChange={(value) => useRemoteWorkspaceStore.getState().setLaunchAgent(value)} options={[
                        { value: "codex", label: "Codex" }, { value: "claude", label: "Claude Code" },
                      ]} />
                    <Button type="primary" icon={<PlusOutlined />} loading={pending[`${host.id}:launch`]}
                      disabled={!connected || !chosenAgent?.installed} onClick={() => void run(() => startRemoteSession(host.id))}>{t("remote.sessions.start")}</Button>
                  </div>
                  {sessions.length > 0 && (
                    <nav className="app-remote-session-tabs" aria-label={t("remote.sessions.title")}>
                      {sessions.map((session) => (
                        <button key={session.id} type="button" aria-pressed={session.id === selectedSession?.id}
                          className="app-remote-session-tab" onClick={() => useRemoteWorkspaceStore.getState().setSelectedSession(host.id, session.id)}>
                          {session.agentId === "shell" ? <CodeOutlined /> : <AgentIcon agentId={session.agentId} size={14} />}
                          <span>{session.title || (session.agentId === "shell" ? t("remote.sessions.shell") : session.agentId === "codex" ? "Codex" : "Claude Code")}</span>
                          <span className="app-remote-session-tab__state">{t(!connected ? "remote.task.disconnected" : `remote.task.${session.taskState}`)}</span>
                        </button>
                      ))}
                    </nav>
                  )}
                  {selectedSession ? (
                    <>
                      <div className="app-remote-session-toolbar">
                        <span className="app-remote-monospace" title={selectedSession.cwd}>{selectedSession.cwd}</span>
                        <span className="app-remote-muted">{connected ? t(`remote.task.${selectedSession.taskState}`) : t("remote.task.disconnected")}</span>
                        {!selectedSession.hookObserved && selectedSession.agentId !== "shell" && selectedSession.processState === "running" && connected && <span className="app-remote-muted">{t("remote.sessions.awaitingHook")}</span>}
                        {selectedSession.processState === "exited" ? (
                          <Button size="small" type="text" icon={<DeleteOutlined />} disabled={!connected}
                            onClick={() => useRemoteWorkspaceStore.getState().setPendingStop({ hostId: host.id, session: selectedSession, action: "forget" })}>{t("remote.sessions.forget")}</Button>
                        ) : (
                          <Button size="small" type="text" danger icon={<StopOutlined />} disabled={!connected}
                            onClick={() => useRemoteWorkspaceStore.getState().setPendingStop({ hostId: host.id, session: selectedSession })}>{t("remote.sessions.stop")}</Button>
                        )}
                      </div>
                      <div className="app-remote-terminal-frame">
                        <RemoteTerminal key={`${host.id}:${selectedSession.id}:${selectedSession.instanceId}`} hostId={host.id} session={selectedSession} active={visible} />
                      </div>
                    </>
                  ) : (
                    <div className="app-remote-terminal-empty">
                      <CodeOutlined />
                      <p>{t(connected ? "remote.sessions.empty" : "remote.sessions.connectFirst")}</p>
                    </div>
                  )}
                </section>
                <footer className="app-remote-status-footer">{t("remote.sessions.survive")}</footer>
              </>
            )}
          </main>
        </div>
      </Modal>
      <RemoteHostEditor />
      <Modal open={!!pendingStop} className="app-remote-stop-modal" title={t(`remote.sessions.${pendingSessionAction}Title`)} okText={t(`remote.sessions.${pendingSessionAction}`)} cancelText={t("common.cancel")}
        okButtonProps={{ danger: true }} confirmLoading={pendingStop ? pending[`${pendingStop.hostId}:${pendingSessionAction}`] : false}
        cancelButtonProps={{ disabled: pendingStop ? pending[`${pendingStop.hostId}:${pendingSessionAction}`] : false }} mask={{ closable: false }}
        onCancel={() => { if (!pendingStop || !pending[`${pendingStop.hostId}:${pendingSessionAction}`]) useRemoteWorkspaceStore.getState().setPendingStop(null); }}
        onOk={() => { if (pendingStop) void run(() => pendingSessionAction === "forget" ? forgetRemoteSession(pendingStop.hostId, pendingStop.session) : stopRemoteSession(pendingStop.hostId, pendingStop.session), pendingStop.hostId); }}>
        <p>{t(`remote.sessions.${pendingSessionAction}Description`, { name: pendingStop?.session.title, pid: pendingStop?.session.pid })}</p>
        {pendingStop && errors[pendingStop.hostId] && <div className="app-remote-error" role="alert"><RemoteErrorMessage error={errors[pendingStop.hostId]!} /></div>}
      </Modal>
      <Modal open={!!pendingServerAction} className="app-remote-server-modal" title={t(`remote.server.${pendingServerAction?.action ?? "stop"}`)}
        okText={t(`remote.server.${pendingServerAction?.action ?? "stop"}`)} cancelText={t("common.cancel")}
        okButtonProps={{ danger: true }} confirmLoading={pendingServerAction ? pending[`${pendingServerAction.hostId}:server`] : false}
        cancelButtonProps={{ disabled: pendingServerAction ? pending[`${pendingServerAction.hostId}:server`] : false }} mask={{ closable: false }}
        onCancel={() => { if (!pendingServerAction || !pending[`${pendingServerAction.hostId}:server`]) useRemoteWorkspaceStore.getState().setPendingServerAction(null); }}
        onOk={() => { if (pendingServerAction) void run(() => manageRemoteServer(pendingServerAction.hostId, pendingServerAction.action), pendingServerAction.hostId); }}>
        <p>{t("remote.server.manageDescription")}</p>
        {pendingServerAction && errors[pendingServerAction.hostId] && <div className="app-remote-error" role="alert"><RemoteErrorMessage error={errors[pendingServerAction.hostId]!} /></div>}
      </Modal>
    </>
  );
}
