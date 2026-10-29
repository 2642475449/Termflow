import { listen } from "@tauri-apps/api/event";
import i18n from "@/i18n";
import { closePty, ptyInput, spawnPty } from "@/lib/api";
import { useAppStore } from "@/store";
import type { Session, TerminalQuickCommand } from "@/types";
import type { BottomRunnerTab, TerminalShell } from "../types";
import { isRunnerRunning, runnerExitStatus, useBottomRunnerStore } from "./bottomRunner";

// 所有异步操作按 sessionId 关联；重跑使用新 ID，晚到的退出事件不会污染新任务。
const pending = new Map<string, { ready: Promise<void>; resolve: () => void; cancelled: boolean }>();
const stopping = new Set<string>();
const restarting = new Set<string>();
let exitListener: Promise<() => void> | undefined;

export function findRunnerTab(sessionId: string) {
  return Object.values(useBottomRunnerStore.getState().tabsByProject).flat().find((tab) => tab.sessionId === sessionId);
}

function updateRunnerSession(tab: BottomRunnerTab, updates: Partial<Session> | null) {
  const app = useAppStore.getState();
  if (app.currentProject?.path === tab.projectPath) {
    if (updates) app.updateSession(tab.sessionId, updates);
    else app.removeSession(tab.sessionId);
    return;
  }
  // 主 store 的旧 action 只处理当前工程；后台工程仅更新其会话集合。
  useAppStore.setState((state) => ({ projectSessions: { ...state.projectSessions,
    [tab.projectPath]: (state.projectSessions[tab.projectPath] ?? []).flatMap((session) =>
      session.id !== tab.sessionId ? [session] : updates ? [{ ...session, ...updates }] : []),
  } }));
}

export function completeRunner(sessionId: string, code: number | null, exited = false) {
  const tab = findRunnerTab(sessionId);
  if (!tab) return;
  // OSC 精确状态优先于随后携带 null 的 pty-exit。
  const status = stopping.has(sessionId) || tab.status === "stopped" ? "stopped"
    : code === null && !isRunnerRunning(tab) ? tab.status : runnerExitStatus(code);
  useBottomRunnerStore.getState().updateTabStatus(tab.projectPath, tab.id, status,
    code === null && tab.exitCode !== null ? tab.exitCode : code);
  updateRunnerSession(tab, { ...(exited ? { active: false } : {}), status: status === "error" ? "error" : status === "stopped" ? "stopped" : "completed" });
  if (exited) stopping.delete(sessionId);
}

function ensureExitListener() {
  exitListener ??= listen<{ session_id: string; code: number | null }>("pty-exit", ({ payload }) => {
    completeRunner(payload.session_id, payload.code, true);
  }).catch((error: unknown) => { exitListener = undefined; throw error; });
  return exitListener;
}

export function markRunnerTerminalReady(sessionId: string) {
  pending.get(sessionId)?.resolve();
}

export function buildRunnerCommand(command: string, shell: TerminalShell, windows: boolean) {
  if (!windows) return `sh -c '${command.replaceAll("'", "'\\''")}' ; exit $?`;
  if (shell === "cmd") return `${command}\r\nexit\r\n`;
  // 捕获代码必须在用户脚本内部执行，兼容 Windows PowerShell 对非终止错误的 $? 语义。
  // 将正文作为字符串解析，追加换行后再捕获，避免行尾注释吞掉退出逻辑。
  const script = command.replaceAll("'", "''");
  // 执行后主动退出交互 shell；显式写 OSC 133，避免 exit 跳过 PowerShell prompt 钩子。
  return `& { $global:LASTEXITCODE = 0; try { . ([scriptblock]::Create('${script}' + [char]10 + '$termflowRunnerOk = $?')); $termflowRunnerExit = if ($global:LASTEXITCODE -ne 0) { $global:LASTEXITCODE } elseif ($termflowRunnerOk) { 0 } else { 1 } } catch { Write-Error $_; $termflowRunnerExit = 1 }; [Console]::Write(([char]27).ToString() + "]133;D;" + $termflowRunnerExit + [char]7); exit $termflowRunnerExit }`;
}

async function disposeRunner(tab: BottomRunnerTab) {
  const spawn = pending.get(tab.sessionId);
  if (spawn) { spawn.cancelled = true; spawn.resolve(); }
  stopping.delete(tab.sessionId);
  try { await closePty(tab.sessionId); }
  catch (error) { console.warn("Failed to close runner PTY:", error); }
  finally { updateRunnerSession(tab, null); }
}

export async function closeRunnerTab(tab: BottomRunnerTab) {
  // 先撤销视图和待派发资格；spawn 兑现后还会再清理一次。
  useBottomRunnerStore.getState().closeTab(tab.projectPath, tab.id);
  await disposeRunner(tab);
}

export async function clearFinishedRunnerTabs(projectPath: string) {
  await Promise.all((useBottomRunnerStore.getState().tabsByProject[projectPath] ?? [])
    .filter((tab) => !isRunnerRunning(tab)).map(closeRunnerTab));
}

export async function stopRunner(tab: BottomRunnerTab) {
  if (!isRunnerRunning(tab) || stopping.has(tab.sessionId)) return;
  stopping.add(tab.sessionId);
  // 尚未派发完成时不能发送输入；取消守卫会在 spawn 返回后回收进程。
  const spawn = pending.get(tab.sessionId);
  if (spawn) {
    spawn.cancelled = true;
    spawn.resolve();
    useBottomRunnerStore.getState().updateTabStatus(tab.projectPath, tab.id, "stopped", null);
    updateRunnerSession(tab, { active: false, status: "stopped" });
    return;
  }
  try { await ptyInput(tab.sessionId, "\x03"); }
  catch (error) { console.warn("Failed to interrupt runner:", error); }
  setTimeout(() => {
    const current = findRunnerTab(tab.sessionId);
    if (!current || !stopping.has(tab.sessionId)) return;
    completeRunner(tab.sessionId, null, true);
    void closePty(tab.sessionId).catch((error: unknown) => console.warn("Failed to terminate runner:", error));
  }, 2000);
}

async function spawnRunner(tab: BottomRunnerTab) {
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  const operation = { ready, resolve: resolveReady, cancelled: false };
  pending.set(tab.sessionId, operation);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // 等待 Terminal 的事件监听真正就绪，短脚本也不会丢失最初的输出。
    await Promise.all([ensureExitListener(), Promise.race([ready, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(i18n.t("bottomRunner.terminalNotReady"))), 15000);
    })])]);
    if (operation.cancelled || !findRunnerTab(tab.sessionId)) return;
    const windows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
    await spawnPty(tab.sessionId, tab.projectPath, false, false,
      buildRunnerCommand(tab.commandText, tab.shell, windows), undefined, tab.shell, undefined, tab.shell);
    if (operation.cancelled || !findRunnerTab(tab.sessionId)) {
      await closePty(tab.sessionId);
      return;
    }
    // 极短脚本可能先退出再兑现 spawn IPC，不能回写 running。
    if (findRunnerTab(tab.sessionId)?.status === "starting") {
      useBottomRunnerStore.getState().updateTabStatus(tab.projectPath, tab.id, "running", null);
      updateRunnerSession(tab, { active: true, status: "running" });
    }
  } catch (error) {
    if (operation.cancelled || !findRunnerTab(tab.sessionId)) return;
    useBottomRunnerStore.getState().updateTabStatus(tab.projectPath, tab.id, "error", -1);
    updateRunnerSession(tab, { active: false, status: "error" });
    throw error;
  } finally {
    clearTimeout(timeout);
    pending.delete(tab.sessionId);
    if (operation.cancelled) {
      stopping.delete(tab.sessionId);
      updateRunnerSession(tab, findRunnerTab(tab.sessionId) ? { active: false, status: "stopped" } : null);
    }
  }
}

function createRunnerSession(tab: BottomRunnerTab) {
  useAppStore.getState().addSession({ id: tab.sessionId, path: tab.projectPath, name: tab.commandLabel,
    createdAt: tab.startTime, active: true, ephemeral: true, hasPromptHistory: false,
    status: "starting", titleSource: "manual", agentId: tab.shell, presentation: "bottom-runner",
  }, { openInWorkspace: false });
}

export async function launchRunner(projectPath: string, command: Pick<TerminalQuickCommand, "id" | "label" | "command">, shell: TerminalShell) {
  const store = useBottomRunnerStore.getState();
  const existing = store.tabsByProject[projectPath]?.find((tab) => tab.commandId === command.id);
  if (existing) { store.activateTab(projectPath, existing.id); store.setOpen(true); return; }
  if (useAppStore.getState().currentProject?.path !== projectPath) return;
  const sessionId = crypto.randomUUID();
  const tab: BottomRunnerTab = { id: `runner:${sessionId}`, sessionId, commandId: command.id,
    commandLabel: command.label, commandText: command.command, projectPath, shell, status: "starting",
    exitCode: null, startTime: Date.now(), endTime: null };
  createRunnerSession(tab);
  const evicted = store.addRunTab(projectPath, tab);
  if (evicted) void disposeRunner(evicted);
  await spawnRunner(tab);
}

export async function rerunRunner(tab: BottomRunnerTab) {
  if (pending.has(tab.sessionId) || stopping.has(tab.sessionId) || restarting.has(tab.sessionId)) return;
  restarting.add(tab.sessionId);
  try {
    // 回收期间保留视图，避免最后一个标签重跑时面板先折叠再展开。
    await disposeRunner(tab);
    if (!findRunnerTab(tab.sessionId)) return;
    if (useAppStore.getState().currentProject?.path !== tab.projectPath) {
      useBottomRunnerStore.getState().updateTabStatus(tab.projectPath, tab.id, "stopped", null);
      return;
    }
    useBottomRunnerStore.getState().closeTab(tab.projectPath, tab.id);
    await launchRunner(tab.projectPath, { id: tab.commandId, label: tab.commandLabel, command: tab.commandText }, tab.shell);
  } finally { restarting.delete(tab.sessionId); }
}
