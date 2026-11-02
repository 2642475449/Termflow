import type { Session } from "@/types";
import { isAiAgentId } from "./agents";
import { containsTerminalInterrupt } from "./terminalSubmission";

const CONFIRMATION_WINDOW_MS = 2_000;
const SETTLE_MS = 80;

export type TerminalInterruptBaseline = Pick<Session,
  "id" | "agentId" | "agentSessionId" | "statusRevision" | "statusUpdatedAt" | "checkpointActiveTurnId"
>;
export interface TerminalScreenLine { row: number; text: string }

/** 权限/提问对话框仍归 CLI 管理；只在普通输入提示符处修复原生插入光标。 */
export function canRestoreTerminalInputCursor(session: Session | undefined): boolean {
  if (!session?.active || session.archived || !isAiAgentId(session.agentId)
    || session.agentId === "antigravity") return false;
  return session.status === "completed" || (session.status === "waiting"
    && (session.lastEventType === "interrupted" || (!session.checkpointActiveTurnId
      && session.lastEventType !== "permission_request" && session.lastEventType !== "waiting_input")));
}

export function isTerminalInterruptBaselineCurrent(
  session: Session | undefined,
  baseline: TerminalInterruptBaseline,
): boolean {
  return Boolean(session?.active && !session.archived && session.status === "running"
    && session.id === baseline.id && session.agentId === baseline.agentId
    && session.agentSessionId === baseline.agentSessionId
    && session.statusRevision === baseline.statusRevision
    && session.statusUpdatedAt === baseline.statusUpdatedAt
    && session.checkpointActiveTurnId === baseline.checkpointActiveTurnId);
}

function cancellationMarkers(agentId: unknown, lines: TerminalScreenLine[]): Map<string, number> {
  const pattern = agentId === "codex"
    ? /^(?:■\s*)?(?:(?:Conversation|Turn) interrupted\b|Interrupted\s*[·—-]\s*Tell the model what to do differently)/i
    : agentId === "claude"
      ? /^(?:⎿\s*)?Interrupted\s*·\s*What should Claude do instead\??$/i
      : null;
  const markers = new Map<string, number>();
  for (const line of lines) {
    const text = line.text.trim();
    if (pattern?.test(text)) markers.set(text, (markers.get(text) ?? 0) + 1);
  }
  return markers;
}

/** 只接受根记录；子智能体的空闲不能证明当前会话已中断。 */
export function parseTerminalProgramStatus(data: string, agentId: unknown): "working" | "idle" | null {
  if (data.length > 4_096) return null;
  const fields = new Map(data.split(":").map((part) => {
    const separator = part.indexOf("=");
    return [part.slice(0, separator), part.slice(separator + 1)];
  }));
  const app = agentId === "claude" ? "claude-code" : agentId === "codex" ? "codex" : null;
  if (!app || fields.get("app") !== app || fields.get("parent")) return null;
  const state = fields.get("state");
  return state === "working" ? "working" : state === "idle" || state === "done" ? "idle" : null;
}

/** 输入写入成功 + 同轮任务的原生空闲/取消证据，才允许补齐缺失的中断 Hook。 */
export function createTerminalAgentInterrupt(options: {
  getSession: () => Session | undefined;
  getScreen: () => TerminalScreenLine[];
  confirm: (baseline: TerminalInterruptBaseline) => void;
}) {
  type Pending = {
    baseline: TerminalInterruptBaseline;
    written: boolean;
    evidence: boolean;
    titleWasWorking: boolean;
    markers: Map<string, number>;
  };
  let pending: Pending | null = null;
  let confirmedBaseline: TerminalInterruptBaseline | null = null;
  let titleWorking = false;
  let programStatusObserved = false;
  let firstEscapeAt = -Infinity;
  let firstEscapeBaseline: TerminalInterruptBaseline | null = null;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let settlement: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const cancel = () => {
    clearTimeout(expiry);
    clearTimeout(settlement);
    pending = null;
    confirmedBaseline = null;
    firstEscapeAt = -Infinity;
    firstEscapeBaseline = null;
  };
  const settle = () => {
    clearTimeout(settlement);
    if (!pending?.written || !pending.evidence) return;
    const candidate = pending;
    settlement = setTimeout(() => {
      if (pending !== candidate) return;
      cancel();
      if (!disposed && isTerminalInterruptBaselineCurrent(options.getSession(), candidate.baseline)) {
        confirmedBaseline = candidate.baseline;
        options.confirm(candidate.baseline);
      }
    }, SETTLE_MS);
  };
  const observe = (state: "working" | "idle") => {
    if (!pending) return;
    if (!isTerminalInterruptBaselineCurrent(options.getSession(), pending.baseline) || state === "working") {
      cancel();
      return;
    }
    pending.evidence = true;
    settle();
  };

  return {
    prepareInput(data: string) {
      if (disposed) return () => {};
      const session = options.getSession();
      if (data.includes("\r") || data.includes("\n")) cancel();
      if (!session?.active || session.status !== "running" || !isAiAgentId(session.agentId)
        || !containsTerminalInterrupt(data, session.agentId)) return () => {};
      const baseline: TerminalInterruptBaseline = {
        id: session.id, agentId: session.agentId, agentSessionId: session.agentSessionId,
        statusRevision: session.statusRevision, statusUpdatedAt: session.statusUpdatedAt,
        checkpointActiveTurnId: session.checkpointActiveTurnId,
      };
      // OpenCode 的第一次 Esc 可能仅关闭界面；第二次仍须等待实际空闲证据。
      if (session.agentId === "opencode" && (data === "\x1b" || data.startsWith("\x1b[27"))) {
        const second = firstEscapeBaseline && isTerminalInterruptBaselineCurrent(session, firstEscapeBaseline)
          && Date.now() - firstEscapeAt <= CONFIRMATION_WINDOW_MS;
        firstEscapeAt = Date.now();
        firstEscapeBaseline = baseline;
        if (!second) return () => {};
      }
      cancel();
      const candidate: Pending = {
        baseline, written: false, evidence: false, titleWasWorking: titleWorking,
        markers: cancellationMarkers(session.agentId, options.getScreen()),
      };
      pending = candidate;
      expiry = setTimeout(cancel, CONFIRMATION_WINDOW_MS);
      return (written = true) => {
        if (pending !== candidate) return;
        if (!written || !isTerminalInterruptBaselineCurrent(options.getSession(), baseline)) cancel();
        else { candidate.written = true; settle(); }
      };
    },
    observeTitle(title: string) {
      const agentId = options.getSession()?.agentId;
      const working = agentId === "claude" ? /^[\u2800-\u28ff\u25d0-\u25d3]/u.test(title.trimStart())
        : agentId === "antigravity" && /^[✦⏲]/u.test(title.trimStart());
      const idle = agentId === "claude" ? title.trimStart().startsWith("✳")
        : agentId === "antigravity" && title.trimStart().startsWith("◇");
      if (working || idle) titleWorking = Boolean(working);
      if (!programStatusObserved && pending?.titleWasWorking && (working || idle)) {
        observe(working ? "working" : "idle");
      }
    },
    observeProgramStatus(data: string) {
      if (data === "state=clear") {
        programStatusObserved = false;
        cancel();
        return;
      }
      const state = parseTerminalProgramStatus(data, options.getSession()?.agentId);
      if (!state || disposed) return;
      programStatusObserved = true;
      observe(state);
    },
    observeScreen() {
      if (!pending || disposed || programStatusObserved) return;
      const markers = cancellationMarkers(pending.baseline.agentId, options.getScreen());
      // 旧提示换行或重排位置不构成新证据，必须真的新增取消提示。
      if ([...markers].some(([marker, count]) => count > (pending?.markers.get(marker) ?? 0))) observe("idle");
    },
    isCurrent: (baseline: TerminalInterruptBaseline) => !disposed && confirmedBaseline === baseline
      && isTerminalInterruptBaselineCurrent(options.getSession(), baseline),
    cancel,
    dispose() { disposed = true; cancel(); },
  };
}
