import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  spawn: vi.fn<(...args: unknown[]) => Promise<void>>(),
  close: vi.fn<(...args: unknown[]) => Promise<void>>(),
  input: vi.fn<(...args: unknown[]) => Promise<void>>(),
  exit: null as null | ((event: { payload: { session_id: string; code: number | null } }) => void),
}));
vi.mock("@/lib/api", () => ({ spawnPty: mocks.spawn, closePty: mocks.close, ptyInput: mocks.input }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_: string, callback: typeof mocks.exit) => {
  mocks.exit = callback;
  return () => {};
}) }));
import { useAppStore } from "@/store";
import { useBottomRunnerStore } from "./bottomRunner";
import { buildRunnerCommand, clearFinishedRunnerTabs, closeRunnerTab, completeRunner, launchRunner,
  markRunnerTerminalReady, rerunRunner, stopRunner } from "./bottomRunnerRuntime";
const path = "D:/project";
const command = { id: "build", label: "Build", command: "echo hello" };
const runner = () => useBottomRunnerStore.getState();
const tab = () => runner().tabsByProject[path][0];
function start(id = "build") {
  const promise = launchRunner(path, { ...command, id }, "powershell");
  const created = runner().tabsByProject[path].at(-1)!;
  markRunnerTerminalReady(created.sessionId);
  return { promise, created };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.spawn.mockResolvedValue(); mocks.close.mockResolvedValue(); mocks.input.mockResolvedValue();
  runner().reset();
  useAppStore.setState({ projectSessions: {}, projectWorkspaces: {} });
  useAppStore.getState().setCurrentProject({ path, name: "Project" });
  useAppStore.getState().addSession({ id: "main", name: "Main", path, active: true, createdAt: 1, agentId: "codex" });
});
afterEach(() => { vi.useRealTimers(); });
it("starts outside the workspace and never changes its active session, focus or tabs", async () => {
  const before = useAppStore.getState();
  const { promise, created } = start();
  expect(mocks.spawn).not.toHaveBeenCalled();
  await promise;
  const after = useAppStore.getState();
  expect(after.activeSessionId).toBe(before.activeSessionId);
  expect(after.focusedTabId).toBe(before.focusedTabId);
  expect(after.projectWorkspaces[path]).toEqual(before.projectWorkspaces[path]);
  expect(after.sessions.find((session) => session.id === created.sessionId)).toMatchObject({ presentation: "bottom-runner", ephemeral: true });
  expect(tab().status).toBe("running");
});
it("reuses the same command in a project and automatically expands it, even after completion", async () => {
  await start().promise;
  completeRunner(tab().sessionId, 0, true);
  runner().setOpen(false);
  await launchRunner(path, command, "powershell");
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(runner().tabsByProject[path]).toHaveLength(1);
  expect(runner().activeTabIdByProject[path]).toBe(tab().id);
  expect(runner().open).toBe(true);
});
it("awaits terminal listener readiness before spawning and can cancel before readiness", async () => {
  const promise = launchRunner(path, command, "powershell");
  await flush();
  expect(mocks.spawn).not.toHaveBeenCalled();
  await closeRunnerTab(tab());
  await promise;
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(useAppStore.getState().sessions.map((session) => session.id)).toEqual(["main"]);
});
it("closes a PTY again if it appears after its tab was closed during spawn", async () => {
  let resolve!: () => void;
  mocks.spawn.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
  const { promise, created } = start();
  await flush();
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  await closeRunnerTab(created);
  resolve();
  await promise;
  expect(mocks.close).toHaveBeenCalledTimes(2);
  expect(runner().tabsByProject[path]).toEqual([]);
  expect(useAppStore.getState().sessions.map((session) => session.id)).toEqual(["main"]);
});
it("does not restore a completed task to running when spawn resolves after exit", async () => {
  mocks.spawn.mockImplementationOnce(async () => { mocks.exit?.({ payload: { session_id: tab().sessionId, code: null } }); });
  await start().promise;
  expect(tab().status).toBe("completed");
  expect(useAppStore.getState().sessions.find((session) => session.id === tab().sessionId)?.active).toBe(false);
});
it("preserves OSC exit codes across null exit events and late OSC parsing without reviving the session", async () => {
  await start().promise;
  const sessionId = tab().sessionId;
  completeRunner(sessionId, 7);
  mocks.exit?.({ payload: { session_id: sessionId, code: null } });
  expect(tab()).toMatchObject({ status: "error", exitCode: 7 });
  completeRunner(sessionId, 7);
  expect(useAppStore.getState().sessions.find((session) => session.id === sessionId)?.active).toBe(false);
});
it("treats null as completed and numeric zero as success", async () => {
  await start().promise;
  completeRunner(tab().sessionId, null, true);
  expect(tab().status).toBe("completed");
  completeRunner(tab().sessionId, 0);
  expect(tab().status).toBe("success");
});
it("reports spawn failure on the retained error tab", async () => {
  mocks.spawn.mockRejectedValueOnce(new Error("spawn failed"));
  await expect(start().promise).rejects.toThrow("spawn failed");
  expect(tab()).toMatchObject({ status: "error", exitCode: -1 });
});
it("cleans sessions in their owning project when the user switches during spawn or close", async () => {
  let resolve!: () => void;
  mocks.spawn.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
  const { promise, created } = start();
  await flush();
  useAppStore.getState().setCurrentProject({ path: "B", name: "B" });
  resolve(); await promise;
  expect(useAppStore.getState().projectSessions[path].find((session) => session.id === created.sessionId)?.status).toBe("running");
  completeRunner(created.sessionId, 0, true);
  await closeRunnerTab(created);
  expect(useAppStore.getState().projectSessions[path].map((session) => session.id)).toEqual(["main"]);
  expect(useAppStore.getState().currentProject?.path).toBe("B");
});
it("soft interrupts first and force kills after two seconds, preserving stopped status", async () => {
  await start().promise;
  vi.useFakeTimers();
  await stopRunner(tab());
  expect(mocks.input).toHaveBeenCalledWith(tab().sessionId, "\x03");
  expect(mocks.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  expect(mocks.close).toHaveBeenCalledWith(tab().sessionId);
  expect(tab().status).toBe("stopped");
  completeRunner(tab().sessionId, null, true);
  expect(tab().status).toBe("stopped");
});
it("does not force kill after a soft interrupt already exited", async () => {
  await start().promise;
  vi.useFakeTimers();
  await stopRunner(tab());
  completeRunner(tab().sessionId, null, true);
  await vi.advanceTimersByTimeAsync(2100);
  expect(mocks.close).not.toHaveBeenCalled();
  expect(tab().status).toBe("stopped");
});
it("cancels an in-flight start on Stop and reclaims the resulting process", async () => {
  let resolve!: () => void;
  mocks.spawn.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
  const { promise } = start(); await flush();
  await stopRunner(tab());
  resolve(); await promise;
  expect(tab().status).toBe("stopped");
  expect(mocks.close).toHaveBeenCalledWith(tab().sessionId);
});
it("reruns with a new session id and ignores stale exit events", async () => {
  await start().promise;
  const old = tab();
  const promise = rerunRunner(old);
  await flush();
  const replacement = tab();
  expect(replacement.sessionId).not.toBe(old.sessionId);
  markRunnerTerminalReady(replacement.sessionId);
  await promise;
  completeRunner(old.sessionId, 9, true);
  expect(tab().status).toBe("running");
  expect(mocks.close).toHaveBeenCalledWith(old.sessionId);
});
it("reclaims finished FIFO tabs including their PTY and main-store session", async () => {
  for (let i = 0; i < 8; i++) await start(String(i)).promise;
  const finished = runner().tabsByProject[path][2];
  completeRunner(finished.sessionId, 0, true);
  await start("8").promise;
  await flush();
  expect(runner().tabsByProject[path]).toHaveLength(8);
  expect(mocks.close).toHaveBeenCalledWith(finished.sessionId);
  expect(useAppStore.getState().sessions.some((session) => session.id === finished.sessionId)).toBe(false);
});
it("clears finished task resources and keeps active tasks", async () => {
  await start("first").promise;
  const finished = tab();
  await start("second").promise;
  completeRunner(finished.sessionId, null, true);
  await clearFinishedRunnerTabs(path);
  expect(runner().tabsByProject[path]).toHaveLength(1);
  expect(runner().tabsByProject[path][0].commandId).toBe("second");
  expect(mocks.close).toHaveBeenCalledWith(finished.sessionId);
});
it("wraps batch commands for shell exit and explicit PowerShell completion", () => {
  expect(buildRunnerCommand("echo hello", "cmd", false)).toBe("sh -c 'echo hello' ; exit $?");
  expect(buildRunnerCommand("echo hello", "cmd", true)).toBe("echo hello\r\nexit\r\n");
  expect(buildRunnerCommand("Write-Output hi", "powershell", true)).toContain("Write-Output hi");
  expect(buildRunnerCommand("Write-Output hi", "powershell", true)).toContain("]133;D;");
});

it.skipIf(process.platform !== "win32").each([
  ["Write-Output hello", 0],
  ["Write-Output 'hello' # trailing comment", 0],
  ["cmd.exe /c exit 7", 7],
  ["Write-Error deliberate_failure", 1],
  ['throw "deliberate_failure"', 1],
])("captures PowerShell success and failure for %s", (commandText, expected) => {
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    buildRunnerCommand(commandText, "powershell", true)], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  expect(result.status).toBe(expected);
  expect(result.stdout).toContain(`\x1b]133;D;${expected}\x07`);
});

it("cancels a pending rerun if its tab is closed while the old PTY is being reclaimed", async () => {
  await start().promise;
  const old = tab();
  let resolve!: () => void;
  mocks.close.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
  const rerun = rerunRunner(old);
  await closeRunnerTab(old);
  resolve(); await rerun;
  expect(runner().tabsByProject[path]).toEqual([]);
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
});
