import type { Session } from "@/types";
import { getNativeSessionTitle, normalizeSessionTitles } from "./sessionTitles";

export const CODEX_MISSING_TITLE_REFRESH_MS = 20_000;
export const CODEX_TITLE_REFRESH_MS = 5 * 60_000;

interface CodexTitleSyncDependencies {
  sessions: () => Session[];
  update: (id: string, change: (session: Session) => Session) => void;
  read: (sessionIds: string[]) => Promise<Record<string, string>>;
  subscribe: (listener: () => void) => () => void;
}

function candidates(sessions: Session[]): Session[] {
  return sessions.filter((session) => session.agentId === "codex" && session.agentSessionId &&
    !session.archived && session.titleSource !== "manual" && !session.manualTitle);
}

/** 原生名称可以晚于对话落盘，也可以晚于 AI 兜底；只按真实会话 ID 同步。 */
export function startCodexTitleSync(deps: CodexTitleSyncDependencies): () => void {
  const checks = new Map<string, { providerId: string; active: boolean; nextAt: number }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;
  let scanAgain = false;
  const signature = () => JSON.stringify(candidates(deps.sessions()).map((session) => [
    session.id, session.agentSessionId, session.active, getNativeSessionTitle(session),
  ]));
  let lastSignature = signature();

  const schedule = () => {
    if (stopped) return;
    if (running) { scanAgain = true; return; }
    clearTimeout(timer);
    timer = setTimeout(() => void tick(), 0);
  };
  const tick = async () => {
    if (stopped || running) return;
    const now = Date.now();
    const sessions = candidates(deps.sessions());
    const ids = new Set(sessions.map((session) => session.id));
    for (const id of checks.keys()) if (!ids.has(id)) checks.delete(id);
    const due = sessions.filter((session) => {
      const checked = checks.get(session.id);
      return !checked || checked.providerId !== session.agentSessionId ||
        checked.active !== session.active || checked.nextAt <= now;
    });
    if (due.length) {
      running = true;
      for (const session of due) checks.set(session.id, {
        providerId: session.agentSessionId!, active: session.active,
        nextAt: now + CODEX_MISSING_TITLE_REFRESH_MS,
      });
      try {
        const titles = await deps.read([...new Set(due.map((session) => session.agentSessionId!))]);
        if (stopped) return;
        for (const session of due) {
          const title = titles[session.agentSessionId!]?.trim();
          if (!title) continue;
          deps.update(session.id, (current) => {
            if (current.agentId !== "codex" || current.archived || current.manualTitle ||
              current.titleSource === "manual" || current.agentSessionId !== session.agentSessionId) return current;
            if (getNativeSessionTitle(current) === title && !current.titleGeneration) return current;
            return normalizeSessionTitles({
              ...current, temporaryTitle: current.temporaryTitle ?? current.name,
              nativeTitle: { sessionId: session.agentSessionId!, title },
              titleGeneration: undefined,
            });
          });
        }
      } catch (error) {
        console.warn("Failed to read Codex session titles:", error);
      } finally {
        running = false;
      }
    }
    if (stopped) return;
    const latest = candidates(deps.sessions());
    const dueIds = new Set(due.map((session) => session.id));
    for (const session of latest) {
      const checked = checks.get(session.id);
      if (!checked || checked.providerId !== session.agentSessionId || checked.active !== session.active) continue;
      if (dueIds.has(session.id)) {
        checked.nextAt = getNativeSessionTitle(session)
          ? (session.active ? Date.now() + CODEX_TITLE_REFRESH_MS : Infinity)
          : Date.now() + CODEX_MISSING_TITLE_REFRESH_MS;
      }
    }
    if (scanAgain) { scanAgain = false; schedule(); return; }
    const nextAt = Math.min(...latest.map((session) => {
      const checked = checks.get(session.id);
      return checked && checked.providerId === session.agentSessionId && checked.active === session.active ? checked.nextAt : 0;
    }));
    if (Number.isFinite(nextAt)) timer = setTimeout(() => void tick(), Math.max(0, nextAt - Date.now()));
  };
  const unsubscribe = deps.subscribe(() => {
    const next = signature();
    if (lastSignature !== next) { lastSignature = next; schedule(); }
  });
  schedule();
  return () => { stopped = true; clearTimeout(timer); unsubscribe(); };
}
