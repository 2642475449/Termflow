import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  connectRemoteHost, deleteRemoteHost, disconnectRemoteHost, getRemoteConnection,
  listRemoteHosts, remoteAuthInput, remoteRequest, saveRemoteHost,
} from "@/lib/api";
import {
  canWriteRemoteSession, isRemoteConnectionBusy, isRemoteHost, remoteErrorText, remoteHostDraft, validateRemoteHostDraft,
  type RemoteHost, type RemoteInspection, type RemoteSession, type RemoteSessionRead,
} from "@/lib/remote";
import type { RemoteWorkspaceState } from "@/store/types";

function publicHost(host: RemoteHost): RemoteHost {
  return { id: host.id, name: host.name, target: host.target,
    ...(host.port === undefined ? {} : { port: host.port }),
    ...(host.identityFile === undefined ? {} : { identityFile: host.identityFile }),
    ...(host.sshConfigFile === undefined ? {} : { sshConfigFile: host.sshConfigFile }) };
}
let mirroredHosts: string | null = null;
const hostMirrorStorage = {
  getItem(name: string): string | null {
    try { mirroredHosts = typeof localStorage === "undefined" ? null : localStorage.getItem(name); }
    catch { mirroredHosts = null; }
    return mirroredHosts;
  },
  setItem(name: string, value: string): void {
    if (value === mirroredHosts) return;
    try { if (typeof localStorage !== "undefined") localStorage.setItem(name, value); mirroredHosts = value; }
    catch { /* SQLite 仍是权威，不让本地镜像失败中断远端输入。 */ }
  },
  removeItem(name: string): void {
    try { if (typeof localStorage !== "undefined") localStorage.removeItem(name); } catch { /* 仅删除缓存。 */ }
    mirroredHosts = null;
  },
};

export const useRemoteWorkspaceStore = create<RemoteWorkspaceState>()(persist((set) => ({
  visible: false, initialized: false, loading: false, hosts: [], selectedHostId: null,
  connections: {}, inspections: {}, sessionsByHost: {}, selectedSessionByHost: {},
  errors: {}, pendingActions: {}, reconnectAttempts: {}, editorOpen: false, hostDraft: remoteHostDraft(),
  cwd: "~", agentId: "codex", pendingStop: null, pendingServerAction: null,
  setVisible: (visible) => set({ visible }),
  setSelectedHost: (selectedHostId) => set({ selectedHostId, pendingStop: null, pendingServerAction: null }),
  setSelectedSession: (hostId, sessionId) => set((state) => ({
    selectedSessionByHost: { ...state.selectedSessionByHost, [hostId]: sessionId },
  })),
  setHostEditor: (host) => set({ editorOpen: host !== false, hostDraft: remoteHostDraft(host || undefined) }),
  setHostDraft: (patch) => set((state) => ({ hostDraft: { ...state.hostDraft, ...patch } })),
  setLaunchDirectory: (cwd) => set({ cwd }),
  setLaunchAgent: (agentId) => set({ agentId }),
  setPendingStop: (pendingStop) => set((state) => ({ pendingStop,
    errors: pendingStop ? { ...state.errors, [pendingStop.hostId]: null } : state.errors })),
  setPendingServerAction: (pendingServerAction) => set((state) => ({ pendingServerAction,
    errors: pendingServerAction ? { ...state.errors, [pendingServerAction.hostId]: null } : state.errors })),
  setError: (hostId, error) => set((state) => ({ errors: { ...state.errors, [hostId]: error } })),
  setSessionSnapshot: (hostId, session) => set((state) => {
    const previous = state.sessionsByHost[hostId] ?? [];
    const existing = previous.find((item) => item.id === session.id);
    if (existing?.instanceId === session.instanceId && existing.revision > session.revision) return state;
    if (existing && (Object.keys(session) as Array<keyof RemoteSession>).every((key) => Object.is(existing[key], session[key]))) return state;
    return {
      sessionsByHost: {
        ...state.sessionsByHost,
        [hostId]: existing ? previous.map((item) => item.id === session.id ? session : item) : [...previous, session],
      },
    };
  }),
}), {
  name: "termflow.remote-hosts.v1",
  storage: createJSONStorage(() => hostMirrorStorage),
  // SQLite 为权威，本地只镜像公开连接配置，不保存认证输入、输出或运行状态。
  partialize: (state) => ({ hosts: state.hosts.map(publicHost), selectedHostId: state.selectedHostId }),
  merge: (persisted, current) => {
    const snapshot = persisted && typeof persisted === "object" ? persisted as Record<string, unknown> : {};
    return {
      ...current,
      hosts: Array.isArray(snapshot.hosts) ? (snapshot.hosts as unknown[]).filter(isRemoteHost).map(publicHost) : [],
      selectedHostId: typeof snapshot.selectedHostId === "string" ? snapshot.selectedHostId : null,
    };
  },
}));

const connectionEpochs = new Map<string, number>();
const runtimeRequests = new Map<string, Promise<void>>();
const launchRequests = new Map<string, { key: string; requestId: string; promise?: Promise<RemoteSession> }>();
const inspectionTimes = new Map<string, number>();
const reconnectPlans = new Map<string, { attempts: number; nextAt: number }>();
const manualDisconnects = new Set<string>();
const RECONNECT_DELAYS = [1000, 3000, 8000];
let loadRequest: Promise<void> | null = null;
let hostsRevision = 0;

function epoch(hostId: string): number { return connectionEpochs.get(hostId) ?? 0; }
export function getRemoteConnectionGeneration(hostId: string): number { return epoch(hostId); }
function advanceEpoch(hostId: string): number {
  const next = epoch(hostId) + 1;
  connectionEpochs.set(hostId, next);
  return next;
}
function setReconnectAttempt(hostId: string, attempt: number) {
  useRemoteWorkspaceStore.setState((state) => state.reconnectAttempts[hostId] === attempt ? state : ({ reconnectAttempts: { ...state.reconnectAttempts, [hostId]: attempt } }));
}
function cancelReconnect(hostId: string) {
  reconnectPlans.delete(hostId);
  setReconnectAttempt(hostId, 0);
}
function canReconnect(connection: import("@/lib/remote").RemoteConnection): boolean {
  return (connection.state === "disconnected" || connection.state === "error")
    && /remote_transport_failed|remote_ssh_disconnected|remote\.errors\.(transportFailed|sshDisconnected)/.test(connection.error ?? "");
}
function setPending(key: string, pending: boolean) {
  useRemoteWorkspaceStore.setState((state) => ({ pendingActions: { ...state.pendingActions, [key]: pending } }));
}
function fail(hostId: string, error: unknown): never {
  useRemoteWorkspaceStore.getState().setError(hostId, remoteErrorText(error));
  throw error;
}
function requireConnected(hostId: string) {
  if (useRemoteWorkspaceStore.getState().connections[hostId]?.state !== "connected") {
    throw new Error("remote.errors.connectionRequired");
  }
}

export async function refreshRemoteHosts(): Promise<void> {
  if (loadRequest) return loadRequest;
  useRemoteWorkspaceStore.setState({ loading: true });
  useRemoteWorkspaceStore.getState().setError("global", null);
  const revision = hostsRevision;
  loadRequest = listRemoteHosts().then((hosts) => {
    if (hostsRevision !== revision) return;
    useRemoteWorkspaceStore.setState((state) => {
      // 配置文件在连接期间被编辑/移除时，保留可控制的连接直到用户主动断开。
      const retained = state.hosts.filter((host) => !hosts.some((item) => item.id === host.id)
        && (state.connections[host.id]?.state === "connected" || isRemoteConnectionBusy(state.connections[host.id])));
      const catalog = [...hosts, ...retained];
      return {
        hosts: catalog, initialized: true,
        selectedHostId: catalog.some((host) => host.id === state.selectedHostId) ? state.selectedHostId : catalog[0]?.id ?? null,
      };
    });
  }).catch((error: unknown) => {
    if (hostsRevision !== revision) return;
    useRemoteWorkspaceStore.getState().setError("global", remoteErrorText(error));
    throw error;
  }).finally(() => {
    useRemoteWorkspaceStore.setState({ loading: false });
    loadRequest = null;
  });
  return loadRequest;
}

export async function saveRemoteHostDraft(): Promise<void> {
  if (useRemoteWorkspaceStore.getState().pendingActions.save) return;
  const draft = useRemoteWorkspaceStore.getState().hostDraft;
  const invalid = validateRemoteHostDraft(draft);
  if (invalid) throw new Error(invalid);
  const discovered = useRemoteWorkspaceStore.getState().hosts.find((host) => host.sshConfigFile && host.target === draft.target.trim());
  const host: RemoteHost = {
    id: draft.id || discovered?.id || crypto.randomUUID(), name: draft.name.trim(), target: draft.target.trim(),
    ...(draft.port.trim() ? { port: Number(draft.port) } : {}),
    ...(draft.identityFile.trim() ? { identityFile: draft.identityFile.trim() } : {}),
  };
  hostsRevision++;
  setPending("save", true);
  try {
    const saved = await saveRemoteHost(host);
    useRemoteWorkspaceStore.setState((state) => ({
      hosts: state.hosts.some((item) => item.id === saved.id)
        ? state.hosts.map((item) => item.id === saved.id ? saved : item) : [...state.hosts, saved],
      selectedHostId: saved.id, editorOpen: false, initialized: true,
    }));
  } finally { setPending("save", false); }
}

export async function removeRemoteHost(hostId: string): Promise<void> {
  const state = useRemoteWorkspaceStore.getState();
  const connection = state.connections[hostId];
  if (state.hosts.find((host) => host.id === hostId)?.sshConfigFile) {
    throw new Error("remote.errors.sshConfigReadOnly");
  }
  if (connection?.state === "connected" || isRemoteConnectionBusy(connection)) {
    throw new Error("remote.errors.disconnectBeforeRemove");
  }
  setPending(`${hostId}:delete`, true);
  hostsRevision++;
  try {
    await deleteRemoteHost(hostId);
    manualDisconnects.add(hostId);
    cancelReconnect(hostId);
    advanceEpoch(hostId);
    useRemoteWorkspaceStore.setState((current) => {
      const hosts = current.hosts.filter((host) => host.id !== hostId);
      return { hosts, initialized: true, selectedHostId: current.selectedHostId === hostId ? hosts[0]?.id ?? null : current.selectedHostId };
    });
  } finally { setPending(`${hostId}:delete`, false); }
}

export async function connectRemoteWorkspace(hostId: string, automatic = false): Promise<void> {
  const state = useRemoteWorkspaceStore.getState();
  if (isRemoteConnectionBusy(state.connections[hostId]) || state.pendingActions[`${hostId}:connect`] || state.pendingActions[`${hostId}:disconnect`]) return;
  const host = state.hosts.find((item) => item.id === hostId);
  if (!host) throw new Error("remote.errors.hostMissing");
  if (!automatic) { cancelReconnect(hostId); manualDisconnects.delete(hostId); }
  const requestEpoch = advanceEpoch(hostId);
  state.setError(hostId, null);
  setPending(`${hostId}:connect`, true);
  // 先显示进度，即使首次 IPC 失败也不会留下无反馈的点击。
  useRemoteWorkspaceStore.setState((current) => ({
    connections: { ...current.connections, [hostId]: { hostId, state: "connecting", authOutput: "", authRevision: 0 } },
  }));
  try {
    const connection = await connectRemoteHost(host);
    if (epoch(hostId) === requestEpoch) {
      useRemoteWorkspaceStore.setState((current) => ({ connections: { ...current.connections, [hostId]: connection } }));
      if (connection.state === "connected") {
        cancelReconnect(hostId);
        await refreshRemoteRuntime(hostId).catch((error: unknown) => {
          useRemoteWorkspaceStore.getState().setError(hostId, remoteErrorText(error));
        });
      }
    }
  } catch (error) {
    if (epoch(hostId) === requestEpoch) {
      useRemoteWorkspaceStore.setState((current) => ({
        connections: { ...current.connections, [hostId]: { hostId, state: "error", error: remoteErrorText(error), authOutput: "", authRevision: 0 } },
      }));
      fail(hostId, error);
    }
  } finally { setPending(`${hostId}:connect`, false); }
}

export async function disconnectRemoteWorkspace(hostId: string): Promise<void> {
  manualDisconnects.add(hostId);
  cancelReconnect(hostId);
  advanceEpoch(hostId);
  setPending(`${hostId}:disconnect`, true);
  useRemoteWorkspaceStore.setState((state) => ({
    connections: { ...state.connections, [hostId]: { hostId, state: "disconnected", authOutput: "", authRevision: 0 } },
  }));
  try { await disconnectRemoteHost(hostId); }
  finally { setPending(`${hostId}:disconnect`, false); }
}

export async function refreshRemoteConnection(hostId: string): Promise<void> {
  const requestEpoch = epoch(hostId);
  const connection = await getRemoteConnection(hostId);
  if (epoch(hostId) !== requestEpoch) return;
  const previous = useRemoteWorkspaceStore.getState().connections[hostId];
  if (previous?.state === "connected" && connection.state !== "connected") {
    advanceEpoch(hostId);
    if (!manualDisconnects.has(hostId) && canReconnect(connection)) {
      reconnectPlans.set(hostId, { attempts: 0, nextAt: Date.now() + RECONNECT_DELAYS[0] });
      setReconnectAttempt(hostId, 1);
    }
  }
  useRemoteWorkspaceStore.setState((state) => ({ connections: { ...state.connections, [hostId]: connection } }));
  if (connection.state === "connected") { cancelReconnect(hostId); await refreshRemoteRuntime(hostId, false); }
}

export async function refreshRemoteRuntime(hostId: string, forceInspection = true): Promise<void> {
  const running = runtimeRequests.get(hostId);
  if (running) return running;
  requireConnected(hostId);
  const requestEpoch = epoch(hostId);
  const existingInspection = useRemoteWorkspaceStore.getState().inspections[hostId];
  const inspect = forceInspection || !existingInspection || Date.now() - (inspectionTimes.get(hostId) ?? 0) > 60_000;
  const request = Promise.all([
    inspect ? remoteRequest<RemoteInspection>(hostId, "inspect", {}) : Promise.resolve(existingInspection),
    remoteRequest<RemoteSession[]>(hostId, "sessions.list", {}),
  ]).then(([inspection, sessions]) => {
    if (epoch(hostId) !== requestEpoch || useRemoteWorkspaceStore.getState().connections[hostId]?.state !== "connected") return;
    if (inspect) inspectionTimes.set(hostId, Date.now());
    useRemoteWorkspaceStore.setState((state) => {
      const selected = state.selectedSessionByHost[hostId];
      const previousSessions = state.sessionsByHost[hostId] ?? [];
      const mergedSessions = sessions.map((session) => {
        const previous = previousSessions.find((item) => item.id === session.id);
        return previous?.instanceId === session.instanceId && previous.revision > session.revision ? previous : session;
      });
      return {
        inspections: { ...state.inspections, [hostId]: inspection },
        sessionsByHost: { ...state.sessionsByHost, [hostId]: mergedSessions },
        selectedSessionByHost: { ...state.selectedSessionByHost, [hostId]: sessions.some((session) => session.id === selected) ? selected : sessions[sessions.length - 1]?.id ?? "" },
      };
    });
  }).finally(() => { if (runtimeRequests.get(hostId) === request) runtimeRequests.delete(hostId); });
  runtimeRequests.set(hostId, request);
  return request;
}

export function startRemoteSession(hostId: string, overrideAgent?: "shell"): Promise<RemoteSession> {
  const state = useRemoteWorkspaceStore.getState();
  try { requireConnected(hostId); } catch (error) { return Promise.reject(error); }
  const agentId = overrideAgent ?? state.agentId;
  const cwd = overrideAgent === "shell" ? "~" : state.cwd.trim() || "~";
  const key = JSON.stringify({ agentId, cwd });
  let launch = launchRequests.get(hostId);
  if (launch?.promise) return launch.promise;
  if (!launch || launch.key !== key) {
    launch = { key, requestId: crypto.randomUUID() };
    launchRequests.set(hostId, launch);
  }
  const pending = launch;
  const requestEpoch = epoch(hostId);
  setPending(`${hostId}:launch`, true);
  state.setError(hostId, null);
  const request = remoteRequest<RemoteSession>(hostId, "sessions.create", {
    requestId: pending.requestId, agentId, cwd, rows: 32, cols: 100,
  }).then((session) => {
    if (epoch(hostId) === requestEpoch) {
      useRemoteWorkspaceStore.getState().setSessionSnapshot(hostId, session);
      useRemoteWorkspaceStore.getState().setSelectedSession(hostId, session.id);
    }
    if (launchRequests.get(hostId) === pending) launchRequests.delete(hostId);
    return session;
  }).catch((error: unknown) => fail(hostId, error)).finally(() => {
    pending.promise = undefined;
    setPending(`${hostId}:launch`, false);
  });
  pending.promise = request;
  return request;
}

export async function stopRemoteSession(hostId: string, session: RemoteSession): Promise<void> {
  requireConnected(hostId);
  setPending(`${hostId}:stop`, true);
  try {
    const result = await remoteRequest<RemoteSession>(hostId, "sessions.stop", { sessionId: session.id, instanceId: session.instanceId });
    useRemoteWorkspaceStore.getState().setSessionSnapshot(hostId, result);
    useRemoteWorkspaceStore.getState().setPendingStop(null);
  } catch (error) { fail(hostId, error); }
  finally { setPending(`${hostId}:stop`, false); }
}

export async function forgetRemoteSession(hostId: string, session: RemoteSession): Promise<void> {
  requireConnected(hostId);
  if (session.processState !== "exited") throw new Error("remote.errors.stopBeforeForget");
  setPending(`${hostId}:forget`, true);
  try {
    await remoteRequest<boolean>(hostId, "sessions.forget", { sessionId: session.id, instanceId: session.instanceId });
    useRemoteWorkspaceStore.setState((state) => {
      const remaining = (state.sessionsByHost[hostId] ?? []).filter((item) => item.id !== session.id);
      return {
        sessionsByHost: { ...state.sessionsByHost, [hostId]: remaining },
        selectedSessionByHost: { ...state.selectedSessionByHost, [hostId]: state.selectedSessionByHost[hostId] === session.id ? remaining[remaining.length - 1]?.id ?? "" : state.selectedSessionByHost[hostId] },
        pendingStop: null,
      };
    });
    await refreshRemoteRuntime(hostId, false).catch((error: unknown) => {
      useRemoteWorkspaceStore.getState().setError(hostId, remoteErrorText(error));
    });
  } catch (error) { fail(hostId, error); }
  finally { setPending(`${hostId}:forget`, false); }
}

export async function manageRemoteServer(hostId: string, action: "stop" | "uninstall"): Promise<void> {
  requireConnected(hostId);
  manualDisconnects.add(hostId);
  cancelReconnect(hostId);
  setPending(`${hostId}:server`, true);
  try {
    await remoteRequest(hostId, `server.${action}`, {});
    await disconnectRemoteWorkspace(hostId);
    useRemoteWorkspaceStore.getState().setPendingServerAction(null);
  } catch (error) {
    if (useRemoteWorkspaceStore.getState().connections[hostId]?.state === "connected") manualDisconnects.delete(hostId);
    fail(hostId, error);
  }
  finally { setPending(`${hostId}:server`, false); }
}

export async function sendRemoteAuthentication(hostId: string, data: string): Promise<void> {
  await remoteAuthInput(hostId, data);
}

export async function writeRemoteSession(hostId: string, session: RemoteSession, data: string): Promise<void> {
  const state = useRemoteWorkspaceStore.getState();
  const current = state.sessionsByHost[hostId]?.find((item) => item.id === session.id);
  if (!canWriteRemoteSession(state.connections[hostId], current) || current?.instanceId !== session.instanceId) {
    throw new Error("remote.errors.connectionRequired");
  }
  await remoteRequest(hostId, "sessions.write", { sessionId: session.id, instanceId: session.instanceId, data });
}

export async function resizeRemoteSession(hostId: string, session: RemoteSession, rows: number, cols: number): Promise<void> {
  requireConnected(hostId);
  await remoteRequest(hostId, "sessions.resize", { sessionId: session.id, instanceId: session.instanceId, rows, cols });
}

export async function readRemoteSession(hostId: string, session: RemoteSession, cursor: number): Promise<RemoteSessionRead> {
  requireConnected(hostId);
  const requestEpoch = epoch(hostId);
  const result = await remoteRequest<RemoteSessionRead>(hostId, "sessions.read", { sessionId: session.id, instanceId: session.instanceId, cursor, maxBytes: 64 * 1024 });
  const state = useRemoteWorkspaceStore.getState();
  const current = state.sessionsByHost[hostId]?.find((item) => item.id === session.id);
  if (epoch(hostId) === requestEpoch && result.sessionId === session.id && result.instanceId === session.instanceId
    && (!current || current.instanceId === session.instanceId)) state.setSessionSnapshot(hostId, result.session);
  return result;
}

/** 仅对原本成功连接的意外断线重试；只重新连接和查询，不创建会话。 */
export async function runRemoteReconnects(now = Date.now()): Promise<void> {
  if (!useRemoteWorkspaceStore.getState().visible) return;
  await Promise.allSettled([...reconnectPlans.entries()].map(async ([hostId, plan]) => {
    const state = useRemoteWorkspaceStore.getState();
    const connection = state.connections[hostId];
    if (manualDisconnects.has(hostId) || !state.hosts.some((host) => host.id === hostId) || !connection) {
      cancelReconnect(hostId); return;
    }
    if (connection.state === "connected") { cancelReconnect(hostId); return; }
    if (isRemoteConnectionBusy(connection)) return;
    if (!canReconnect(connection)) { cancelReconnect(hostId); return; }
    if (plan.nextAt === Number.POSITIVE_INFINITY) {
      if (plan.attempts >= RECONNECT_DELAYS.length) { cancelReconnect(hostId); return; }
      plan.nextAt = now + RECONNECT_DELAYS[plan.attempts];
      setReconnectAttempt(hostId, plan.attempts + 1);
    }
    if (now < plan.nextAt) return;
    plan.attempts++;
    plan.nextAt = Number.POSITIVE_INFINITY;
    setReconnectAttempt(hostId, plan.attempts);
    try { await connectRemoteWorkspace(hostId, true); }
    catch { /* 连接错误已落入 store；只有传输掉线可进入下一次退避。 */ }
  }));
}

/** 仅同步已连接或正在认证的主机；不会因打开工作台自动登录服务器。 */
export function startRemoteWorkspacePolling(): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    const state = useRemoteWorkspaceStore.getState();
    const hosts = state.hosts.filter((host) => {
      const connection = state.connections[host.id];
      return connection?.state === "connected" || isRemoteConnectionBusy(connection);
    });
    await Promise.allSettled(hosts.map(async (host) => {
      try { await refreshRemoteConnection(host.id); }
      catch (error) { useRemoteWorkspaceStore.getState().setError(host.id, remoteErrorText(error)); }
    }));
    if (!disposed) await runRemoteReconnects();
    if (!disposed) timer = setTimeout(() => { void poll(); }, 1200);
  };
  void poll();
  return () => { disposed = true; if (timer) clearTimeout(timer); };
}
