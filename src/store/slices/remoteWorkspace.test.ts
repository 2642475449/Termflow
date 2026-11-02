import { beforeEach, expect, test, vi } from "vitest";
import type { RemoteConnection, RemoteHost, RemoteInspection, RemoteSession, RemoteSessionRead } from "@/lib/remote";

const api = vi.hoisted(() => ({
  connectRemoteHost: vi.fn(), deleteRemoteHost: vi.fn(), disconnectRemoteHost: vi.fn(),
  getRemoteConnection: vi.fn(), listRemoteHosts: vi.fn(), remoteAuthInput: vi.fn(),
  remoteRequest: vi.fn(), saveRemoteHost: vi.fn(),
}));
vi.mock("@/lib/api", () => api);

import {
  connectRemoteWorkspace, disconnectRemoteWorkspace, forgetRemoteSession, readRemoteSession, refreshRemoteConnection,
  refreshRemoteHosts, refreshRemoteRuntime, removeRemoteHost, runRemoteReconnects, saveRemoteHostDraft, startRemoteSession,
  stopRemoteSession, useRemoteWorkspaceStore, writeRemoteSession,
} from "./remoteWorkspace";

let hostCounter = 0;
let host: RemoteHost;
const session = (patch: Partial<RemoteSession> = {}): RemoteSession => ({
  id: "session-a", instanceId: "instance-a", agentId: "codex", cwd: "/home/dev/work", title: "Codex",
  pid: 100, processState: "running", taskState: "running", revision: 1, createdAt: 1000,
  exitCode: null, hookObserved: true, outputStart: 0, outputEnd: 10, rows: 32, cols: 100, ...patch,
});
const connected = (hostId: string): RemoteConnection => ({ hostId, state: "connected", authOutput: "", authRevision: 0 });
const inspection: RemoteInspection = { agents: [], pythonVersion: "3.12", helperVersion: 1 };

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  host = { id: `host-${++hostCounter}`, name: "Development server", target: "dev@linux" };
  useRemoteWorkspaceStore.setState({ ...useRemoteWorkspaceStore.getInitialState(), hosts: [host], selectedHostId: host.id });
});

test("backend host catalog replaces the public local mirror", async () => {
  const authoritative = { id: "saved-host", name: "Saved server", target: "saved@linux" };
  api.listRemoteHosts.mockResolvedValue([authoritative]);
  await refreshRemoteHosts();
  expect(useRemoteWorkspaceStore.getState().hosts).toEqual([authoritative]);
  expect(useRemoteWorkspaceStore.getState().selectedHostId).toBe(authoritative.id);
});

test("existing SSH aliases including Chinese appear without saving or connecting", async () => {
  const aliases = ["myserver", "infini-ai", "8g", "电信", "82"];
  const discovered = aliases.map((target, index) => ({ id: `ssh-config-${index}`, name: target, target, sshConfigFile: "user/.ssh/config" }));
  api.listRemoteHosts.mockResolvedValue(discovered);
  await refreshRemoteHosts();
  expect(useRemoteWorkspaceStore.getState().hosts).toEqual(discovered);
  expect(api.saveRemoteHost).not.toHaveBeenCalled();
  expect(api.connectRemoteHost).not.toHaveBeenCalled();
});

test("config discovery does not remove an active connection when its file changes", async () => {
  api.listRemoteHosts.mockResolvedValue([]);
  useRemoteWorkspaceStore.setState({ connections: { [host.id]: connected(host.id) } });
  await refreshRemoteHosts();
  expect(useRemoteWorkspaceStore.getState().hosts).toEqual([host]);
  expect(useRemoteWorkspaceStore.getState().selectedHostId).toBe(host.id);
  expect(api.disconnectRemoteHost).not.toHaveBeenCalled();
});

test("removing a discovered host cannot modify the user's SSH configuration", async () => {
  useRemoteWorkspaceStore.setState({ hosts: [{ ...host, sshConfigFile: "user/.ssh/config" }] });
  await expect(removeRemoteHost(host.id)).rejects.toThrow("remote.errors.sshConfigReadOnly");
  expect(api.deleteRemoteHost).not.toHaveBeenCalled();
});

test("a manual override of a discovered alias retains its identity without duplicate rows", async () => {
  useRemoteWorkspaceStore.setState({ hosts: [{ ...host, sshConfigFile: "user/.ssh/config" }] });
  useRemoteWorkspaceStore.getState().setHostDraft({ name: "Custom label", target: host.target });
  api.saveRemoteHost.mockImplementation(async (value: RemoteHost) => value);
  await saveRemoteHostDraft();
  expect(api.saveRemoteHost).toHaveBeenCalledWith(expect.objectContaining({ id: host.id, name: "Custom label" }));
  expect(useRemoteWorkspaceStore.getState().hosts).toHaveLength(1);
  expect(useRemoteWorkspaceStore.getState().hosts[0].sshConfigFile).toBeUndefined();
});

test("persisted mirror excludes SSH output and live connection/session state", () => {
  useRemoteWorkspaceStore.setState({
    connections: { [host.id]: { ...connected(host.id), authOutput: "private authentication output" } },
    sessionsByHost: { [host.id]: [session()] },
  });
  const partialize = useRemoteWorkspaceStore.persist.getOptions().partialize;
  const snapshot = partialize?.(useRemoteWorkspaceStore.getState());
  expect(snapshot).toEqual({ hosts: [host], selectedHostId: host.id });
  expect(JSON.stringify(snapshot)).not.toContain("private authentication output");
});

test("the host mirror whitelists metadata instead of persisting extra credential fields", () => {
  const extraHost = { ...host, password: "do not persist", token: "secret" };
  useRemoteWorkspaceStore.setState({ hosts: [extraHost] });
  const snapshot = useRemoteWorkspaceStore.persist.getOptions().partialize?.(useRemoteWorkspaceStore.getState());
  expect(snapshot).toEqual({ hosts: [host], selectedHostId: host.id });
});

test("closing the workspace only hides it and never disconnects or stops sessions", () => {
  useRemoteWorkspaceStore.setState({ visible: true, sessionsByHost: { [host.id]: [session()] } });
  useRemoteWorkspaceStore.getState().setVisible(false);
  expect(useRemoteWorkspaceStore.getState().sessionsByHost[host.id][0].processState).toBe("running");
  expect(api.disconnectRemoteHost).not.toHaveBeenCalled();
  expect(api.remoteRequest).not.toHaveBeenCalled();
});

test("disconnect keeps task state and rejects subsequent input without queuing", async () => {
  useRemoteWorkspaceStore.setState({ connections: { [host.id]: connected(host.id) }, sessionsByHost: { [host.id]: [session()] } });
  api.disconnectRemoteHost.mockResolvedValue(undefined);
  await disconnectRemoteWorkspace(host.id);
  expect(useRemoteWorkspaceStore.getState().sessionsByHost[host.id][0].taskState).toBe("running");
  await expect(writeRemoteSession(host.id, session(), "dangerous command\r")).rejects.toThrow("remote.errors.connectionRequired");
  expect(api.remoteRequest).not.toHaveBeenCalled();
});

test("late connection polling cannot undo an explicit disconnect", async () => {
  const response = deferred<RemoteConnection>();
  api.getRemoteConnection.mockReturnValue(response.promise);
  api.disconnectRemoteHost.mockResolvedValue(undefined);
  useRemoteWorkspaceStore.setState({ connections: { [host.id]: connected(host.id) } });
  const refresh = refreshRemoteConnection(host.id);
  await disconnectRemoteWorkspace(host.id);
  response.resolve(connected(host.id));
  await refresh;
  expect(useRemoteWorkspaceStore.getState().connections[host.id].state).toBe("disconnected");
  expect(api.remoteRequest).not.toHaveBeenCalled();
});

test("late connect results cannot restore a cancelled connection", async () => {
  const response = deferred<RemoteConnection>();
  api.connectRemoteHost.mockReturnValue(response.promise);
  api.disconnectRemoteHost.mockResolvedValue(undefined);
  const connect = connectRemoteWorkspace(host.id);
  await disconnectRemoteWorkspace(host.id);
  response.resolve(connected(host.id));
  await connect;
  expect(useRemoteWorkspaceStore.getState().connections[host.id].state).toBe("disconnected");
});

test("concurrent launch clicks share one idempotent request", async () => {
  const response = deferred<RemoteSession>();
  api.remoteRequest.mockReturnValue(response.promise);
  useRemoteWorkspaceStore.setState({ connections: { [host.id]: connected(host.id) } });
  const first = startRemoteSession(host.id);
  const second = startRemoteSession(host.id);
  expect(first).toBe(second);
  expect(api.remoteRequest).toHaveBeenCalledTimes(1);
  expect(api.remoteRequest).toHaveBeenCalledWith(host.id, "sessions.create", expect.objectContaining({ agentId: "codex", cwd: "~", requestId: expect.any(String) }));
  response.resolve(session());
  await first;
  expect(useRemoteWorkspaceStore.getState().selectedSessionByHost[host.id]).toBe("session-a");
});

test("an ambiguous failed launch reuses its request identifier on retry", async () => {
  api.remoteRequest.mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce(session());
  useRemoteWorkspaceStore.setState({ connections: { [host.id]: connected(host.id) } });
  await expect(startRemoteSession(host.id)).rejects.toThrow("response lost");
  const originalId = (api.remoteRequest.mock.calls[0][2] as { requestId: string }).requestId;
  await startRemoteSession(host.id);
  expect((api.remoteRequest.mock.calls[1][2] as { requestId: string }).requestId).toBe(originalId);
});

test("a delayed session list preserves a newer status revision delivered by output", async () => {
  const listed = deferred<RemoteSession[]>();
  api.remoteRequest.mockImplementation((_hostId: string, method: string) => method === "inspect" ? Promise.resolve(inspection) : listed.promise);
  useRemoteWorkspaceStore.setState({ connections: { [host.id]: connected(host.id) }, sessionsByHost: { [host.id]: [session()] } });
  const refresh = refreshRemoteRuntime(host.id);
  useRemoteWorkspaceStore.getState().setSessionSnapshot(host.id, session({ revision: 5, taskState: "completed" }));
  listed.resolve([session({ revision: 2, taskState: "running" })]);
  await refresh;
  expect(useRemoteWorkspaceStore.getState().sessionsByHost[host.id][0]).toMatchObject({ revision: 5, taskState: "completed" });
});

test("late output from an old instance cannot replace a newer session instance", async () => {
  const response = deferred<RemoteSessionRead>();
  api.remoteRequest.mockReturnValue(response.promise);
  useRemoteWorkspaceStore.setState({ connections: { [host.id]: connected(host.id) }, sessionsByHost: { [host.id]: [session()] } });
  const read = readRemoteSession(host.id, session(), 0);
  expect(api.remoteRequest).toHaveBeenCalledWith(host.id, "sessions.read", expect.objectContaining({ instanceId: "instance-a" }));
  useRemoteWorkspaceStore.getState().setSessionSnapshot(host.id, session({ instanceId: "instance-b", revision: 1 }));
  response.resolve({ sessionId: "session-a", instanceId: "instance-a", offset: 0, nextOffset: 0, data: "", truncated: false, session: session({ revision: 8 }) });
  await read;
  expect(useRemoteWorkspaceStore.getState().sessionsByHost[host.id][0].instanceId).toBe("instance-b");
});

test("same remote paths on different hosts keep independent sessions", () => {
  useRemoteWorkspaceStore.getState().setSessionSnapshot(host.id, session());
  useRemoteWorkspaceStore.getState().setSessionSnapshot("other-host", session({ title: "Other Codex", pid: 200 }));
  expect(useRemoteWorkspaceStore.getState().sessionsByHost[host.id][0].pid).toBe(100);
  expect(useRemoteWorkspaceStore.getState().sessionsByHost["other-host"][0].pid).toBe(200);
});

test("stop uses the explicit instance and accepts the helper's session result", async () => {
  api.remoteRequest.mockResolvedValue(session({ processState: "exited", taskState: "stopped", revision: 2, exitCode: -15 }));
  useRemoteWorkspaceStore.setState({ connections: { [host.id]: connected(host.id) }, sessionsByHost: { [host.id]: [session()] } });
  await stopRemoteSession(host.id, session());
  expect(api.remoteRequest).toHaveBeenCalledWith(host.id, "sessions.stop", { sessionId: "session-a", instanceId: "instance-a" });
  expect(useRemoteWorkspaceStore.getState().sessionsByHost[host.id][0].processState).toBe("exited");
});

test("forget removes an exited record without stopping another running session", async () => {
  const ended = session({ processState: "exited", taskState: "stopped", revision: 2 });
  const other = session({ id: "other-session", instanceId: "other-instance" });
  api.remoteRequest.mockImplementation((_hostId: string, method: string) => Promise.resolve(method === "sessions.forget" ? true : method === "sessions.list" ? [other] : inspection));
  useRemoteWorkspaceStore.setState({ connections: { [host.id]: connected(host.id) }, sessionsByHost: { [host.id]: [ended, other] }, selectedSessionByHost: { [host.id]: ended.id } });
  await forgetRemoteSession(host.id, ended);
  expect(api.remoteRequest).toHaveBeenCalledWith(host.id, "sessions.forget", { sessionId: ended.id, instanceId: ended.instanceId });
  expect(api.remoteRequest.mock.calls.some((call) => call[1] === "sessions.stop")).toBe(false);
  expect(useRemoteWorkspaceStore.getState().sessionsByHost[host.id]).toEqual([other]);
  expect(useRemoteWorkspaceStore.getState().selectedSessionByHost[host.id]).toBe(other.id);
});

test("forget rejects a running session before sending a request", async () => {
  useRemoteWorkspaceStore.setState({ connections: { [host.id]: connected(host.id) }, sessionsByHost: { [host.id]: [session()] } });
  await expect(forgetRemoteSession(host.id, session())).rejects.toThrow("remote.errors.stopBeforeForget");
  expect(api.remoteRequest).not.toHaveBeenCalled();
});

test("host saving sends only connection metadata and clears the editor", async () => {
  api.saveRemoteHost.mockImplementation((value: RemoteHost) => Promise.resolve(value));
  useRemoteWorkspaceStore.getState().setHostEditor(null);
  useRemoteWorkspaceStore.getState().setHostDraft({ name: " Linux server ", target: " dev@linux ", port: "2222", identityFile: " C:/keys/dev " });
  await saveRemoteHostDraft();
  expect(api.saveRemoteHost).toHaveBeenCalledWith({ id: expect.any(String), name: "Linux server", target: "dev@linux", port: 2222, identityFile: "C:/keys/dev" });
  expect(useRemoteWorkspaceStore.getState().editorOpen).toBe(false);
});

test("transport loss schedules a bounded reconnect and never creates a session", async () => {
  useRemoteWorkspaceStore.setState({ visible: true, connections: { [host.id]: connected(host.id) }, sessionsByHost: { [host.id]: [session()] } });
  api.getRemoteConnection.mockResolvedValue({ ...connected(host.id), state: "disconnected", error: "remote_ssh_disconnected" });
  api.connectRemoteHost.mockResolvedValue(connected(host.id));
  api.remoteRequest.mockImplementation((_hostId: string, method: string) => Promise.resolve(method === "inspect" ? inspection : [session()]));
  const droppedAt = Date.now();
  await refreshRemoteConnection(host.id);
  await runRemoteReconnects(droppedAt + 500);
  expect(api.connectRemoteHost).not.toHaveBeenCalled();
  await runRemoteReconnects(droppedAt + 1500);
  expect(api.connectRemoteHost).toHaveBeenCalledTimes(1);
  expect(api.remoteRequest.mock.calls.some((call) => call[1] === "sessions.create")).toBe(false);
  expect(useRemoteWorkspaceStore.getState().sessionsByHost[host.id][0].id).toBe("session-a");
});

test("a user disconnect cancels an already scheduled reconnect", async () => {
  useRemoteWorkspaceStore.setState({ visible: true, connections: { [host.id]: connected(host.id) } });
  api.getRemoteConnection.mockResolvedValue({ ...connected(host.id), state: "disconnected", error: "remote_ssh_disconnected" });
  api.disconnectRemoteHost.mockResolvedValue(undefined);
  await refreshRemoteConnection(host.id);
  await disconnectRemoteWorkspace(host.id);
  await runRemoteReconnects(Date.now() + 100_000);
  expect(api.connectRemoteHost).not.toHaveBeenCalled();
  expect(useRemoteWorkspaceStore.getState().reconnectAttempts[host.id]).toBe(0);
});

test("hiding the workspace pauses reconnect attempts", async () => {
  useRemoteWorkspaceStore.setState({ visible: true, connections: { [host.id]: connected(host.id) } });
  api.getRemoteConnection.mockResolvedValue({ ...connected(host.id), state: "disconnected", error: "remote_transport_failed" });
  await refreshRemoteConnection(host.id);
  useRemoteWorkspaceStore.getState().setVisible(false);
  await runRemoteReconnects(Date.now() + 10_000);
  expect(api.connectRemoteHost).not.toHaveBeenCalled();
});

test("reconnect attempts stop after three transport failures", async () => {
  useRemoteWorkspaceStore.setState({ visible: true, connections: { [host.id]: connected(host.id) } });
  const dropped = { ...connected(host.id), state: "disconnected", error: "remote_transport_failed" };
  api.getRemoteConnection.mockResolvedValue(dropped);
  api.connectRemoteHost.mockResolvedValue({ ...connected(host.id), state: "connecting" });
  await refreshRemoteConnection(host.id);
  let now = Date.now() + 2000;
  for (let attempt = 0; attempt < 3; attempt++) {
    await runRemoteReconnects(now);
    await refreshRemoteConnection(host.id);
    await runRemoteReconnects(now + 1);
    now += 10_000;
  }
  await runRemoteReconnects(now + 100_000);
  expect(api.connectRemoteHost).toHaveBeenCalledTimes(3);
  expect(useRemoteWorkspaceStore.getState().reconnectAttempts[host.id]).toBe(0);
});

test("first-connection authentication or deployment errors do not automatically retry", async () => {
  useRemoteWorkspaceStore.setState({ visible: true, connections: { [host.id]: { ...connected(host.id), state: "authenticating" } } });
  api.getRemoteConnection.mockResolvedValue({ ...connected(host.id), state: "error", error: "remote_ssh_closed_before_ready" });
  await refreshRemoteConnection(host.id);
  await runRemoteReconnects(Date.now() + 100_000);
  expect(api.connectRemoteHost).not.toHaveBeenCalled();
});

test("a saved host is not overwritten by an older initial database read", async () => {
  const listing = deferred<RemoteHost[]>();
  api.listRemoteHosts.mockReturnValue(listing.promise);
  api.saveRemoteHost.mockImplementation((value: RemoteHost) => Promise.resolve(value));
  const loading = refreshRemoteHosts();
  useRemoteWorkspaceStore.getState().setHostEditor(null);
  useRemoteWorkspaceStore.getState().setHostDraft({ name: "New server", target: "new@linux" });
  await saveRemoteHostDraft();
  listing.resolve([host]);
  await loading;
  expect(useRemoteWorkspaceStore.getState().hosts).toHaveLength(2);
});
