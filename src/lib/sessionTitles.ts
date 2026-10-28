import type { Session } from "@/types";
import { sanitizeSessionTitle } from "@/components/terminalTitle";

export const TITLE_RETRY_DELAYS = [20_000, 60_000];
export const CODEX_NATIVE_TITLE_WAIT_MS = 60_000;

export function getNativeSessionTitle(session: Session): string | undefined {
  return session.agentId === "codex" && session.nativeTitle?.sessionId === session.agentSessionId
    ? session.nativeTitle?.title.trim() || undefined : undefined;
}

export function normalizeSessionTitles(session: Session): Session {
  const manualTitle = session.titleSource === "manual"
    ? session.manualTitle || session.name : session.manualTitle;
  // 旧 auto 字段无法区分模型结果和兜底，只能保守迁移为临时标题。
  const temporaryTitle = session.temporaryTitle ??
    (session.titleSource === "auto" ? session.firstPromptTitle || session.name : undefined);
  const nativeTitle = getNativeSessionTitle(session);
  return {
    ...session, manualTitle, temporaryTitle,
    name: manualTitle || nativeTitle || session.generatedTitle || temporaryTitle || session.name,
    titleSource: manualTitle ? "manual" : nativeTitle || session.generatedTitle || temporaryTitle ? "auto" : session.titleSource,
  };
}

export function queueSessionTitle(session: Session, input: string, force = false): Session {
  const current = normalizeSessionTitles(session);
  const prompt = input.trim().slice(0, 4096);
  if (!prompt || current.manualTitle || getNativeSessionTitle(current) || (!force && current.generatedTitle)) return current;
  if (!force && current.titleGeneration && current.titleGeneration.status !== "failed") return current;
  const shell = current.agentId === "powershell" || current.agentId === "cmd";
  if (shell && current.temporaryTitle) return current;
  const temporaryTitle = sanitizeSessionTitle(prompt, false, shell ? "terminal" : "agent")
    ?? current.temporaryTitle;
  return normalizeSessionTitles({
    ...current, temporaryTitle,
    titleGeneration: shell ? undefined : {
      prompt, status: "pending", attempts: 0,
      ...(current.agentId === "codex" ? { notBefore: Date.now() + CODEX_NATIVE_TITLE_WAIT_MS } : {}),
    },
  });
}

export function completeSessionTitle(
  session: Session, requestId: string, result: { title: string } | { error: string }, now: number,
): Session {
  const generation = session.titleGeneration;
  if (!generation || generation.requestId !== requestId || session.titleSource === "manual" || session.manualTitle || getNativeSessionTitle(session)) return session;
  if ("title" in result) {
    const title = sanitizeSessionTitle(result.title, true);
    if (title) return normalizeSessionTitles({
      ...session, generatedTitle: title,
      titleGeneration: { ...generation, status: "succeeded", error: undefined, nextRetryAt: undefined },
    });
    return completeSessionTitle(session, requestId, { error: "invalid-title" }, now);
  }
  const delay = TITLE_RETRY_DELAYS[generation.attempts - 1];
  return { ...session, titleGeneration: {
    ...generation, status: "failed", error: result.error,
    nextRetryAt: delay === undefined ? undefined : now + delay,
  } };
}

interface TitleGenerationDependencies {
  sessions: () => Session[];
  update: (id: string, change: (session: Session) => Session) => void;
  generate: (prompt: string, path: string) => Promise<string>;
  subscribe: (listener: () => void) => () => void;
}

/** 应用级调度，不依赖终端挂载；串行生成，避免同时启动多个 CLI。 */
export function startTitleGeneration(deps: TitleGenerationDependencies): () => void {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (stopped || running) return;
    clearTimeout(timer);
    timer = setTimeout(() => void tick(), 0);
  };
  const tick = async () => {
    if (stopped || running) return;
    const now = Date.now();
    const candidates = deps.sessions().filter((session) => !session.archived &&
      session.titleSource !== "manual" && !session.manualTitle && !getNativeSessionTitle(session) && session.titleGeneration);
    const session = candidates.find(({ titleGeneration: job }) => (job?.status === "pending" && (job.notBefore ?? 0) <= now) ||
      (job?.status === "failed" && job.nextRetryAt !== undefined && job.nextRetryAt <= now));
    if (!session?.titleGeneration) {
      const next = candidates.flatMap(({ titleGeneration: job }) =>
        job?.status === "failed" && job.nextRetryAt !== undefined ? [job.nextRetryAt] :
          job?.status === "pending" && job.notBefore !== undefined ? [job.notBefore] : []);
      if (next.length) timer = setTimeout(() => void tick(), Math.max(0, Math.min(...next) - now));
      return;
    }
    running = true;
    const requestId = crypto.randomUUID();
    const job = session.titleGeneration;
    deps.update(session.id, (current) => ({ ...current, titleGeneration: {
      ...job, status: "generating", attempts: job.attempts + 1, requestId, nextRetryAt: undefined,
    } }));
    try {
      const title = await deps.generate(job.prompt, session.path);
      if (!stopped) deps.update(session.id, (current) => completeSessionTitle(current, requestId, { title }, Date.now()));
    } catch (error) {
      if (!stopped) deps.update(session.id, (current) => completeSessionTitle(current, requestId, {
        error: error instanceof Error ? error.message : String(error),
      }, Date.now()));
    } finally {
      running = false;
      schedule();
    }
  };
  // 上次进程退出时未完成的请求重新排队，不把它视为已生成。
  for (const session of deps.sessions()) {
    const job = session.titleGeneration;
    const waitForNative = session.agentId === "codex" && !getNativeSessionTitle(session) && job &&
      (job.status === "pending" || job.status === "generating" ||
        (job.status === "failed" && job.nextRetryAt !== undefined));
    if (job && (job.status === "generating" || waitForNative)) {
      // 重启后也先给原生索引一次读取机会，不能因旧期限已过而立即重复生成。
      const notBefore = waitForNative ? Math.max(job.notBefore ?? 0, Date.now() + CODEX_NATIVE_TITLE_WAIT_MS) : job.notBefore;
      deps.update(session.id, (current) => ({
        ...current, titleGeneration: {
          ...job, status: job.status === "generating" ? "pending" : job.status, requestId: undefined,
          notBefore,
          ...(waitForNative && job.nextRetryAt !== undefined
            ? { nextRetryAt: Math.max(job.nextRetryAt, notBefore!) } : {}),
        },
      }));
    }
  }
  const unsubscribe = deps.subscribe(schedule);
  schedule();
  return () => { stopped = true; clearTimeout(timer); unsubscribe(); };
}
