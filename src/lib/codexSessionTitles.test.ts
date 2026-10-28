import { afterEach, expect, it, vi } from "vitest";
import type { Session } from "@/types";
import { CODEX_MISSING_TITLE_REFRESH_MS, CODEX_TITLE_REFRESH_MS, startCodexTitleSync } from "./codexSessionTitles";
import { completeSessionTitle, normalizeSessionTitles } from "./sessionTitles";

const makeSession = (patch: Partial<Session> = {}): Session => ({
  id: "s", path: "E:/project", name: "临时名称", temporaryTitle: "临时名称", createdAt: 1,
  active: true, agentId: "codex", agentSessionId: "thread-1", ...patch,
});
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; vi.restoreAllMocks(); vi.useRealTimers(); });

function start(initial: Session[], read: (ids: string[]) => Promise<Record<string, string>>) {
  vi.useFakeTimers();
  let sessions = initial;
  let notify = () => {};
  const update = (id: string, change: (session: Session) => Session) => {
    sessions = sessions.map((session) => session.id === id ? change(session) : session);
    notify();
  };
  stop = startCodexTitleSync({ sessions: () => sessions, update, read,
    subscribe: (listener) => { notify = listener; return () => { notify = () => {}; }; },
  });
  return { sessions: () => sessions, update };
}

it("batches exact IDs, skips manual and archived sessions, and keeps native punctuation", async () => {
  const read = vi.fn().mockResolvedValue({ "thread-1": "原生：完整标题 / 标点", "thread-2": "另一段对话" });
  const state = start([makeSession(), makeSession({ id: "s2", agentSessionId: "thread-2" }),
    makeSession({ id: "manual", titleSource: "manual", name: "我的名字" }),
    makeSession({ id: "archived", archived: true }), makeSession({ id: "unknown", agentSessionId: null }),
  ], read);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledWith(["thread-1", "thread-2"]);
  expect(state.sessions().map((session) => session.name)).toEqual([
    "原生：完整标题 / 标点", "另一段对话", "我的名字", "临时名称", "临时名称",
  ]);
});

it("rechecks missing titles and adopts a late native title over an AI fallback", async () => {
  const read = vi.fn().mockResolvedValueOnce({}).mockResolvedValue({ "thread-1": "原生名称" });
  const state = start([makeSession({ generatedTitle: "AI 名称", name: "AI 名称" })], read);
  await vi.advanceTimersByTimeAsync(1);
  expect(state.sessions()[0].name).toBe("AI 名称");
  await vi.advanceTimersByTimeAsync(CODEX_MISSING_TITLE_REFRESH_MS);
  expect(state.sessions()[0].name).toBe("原生名称");
  expect(state.sessions()[0].generatedTitle).toBe("AI 名称");
  await vi.advanceTimersByTimeAsync(CODEX_TITLE_REFRESH_MS);
  expect(read).toHaveBeenCalledTimes(3);
});

it("ignores an in-flight native result after manual rename or provider identity replacement", async () => {
  let resolve!: (titles: Record<string, string>) => void;
  const read = vi.fn(() => new Promise<Record<string, string>>((done) => { resolve = done; }));
  const state = start([makeSession(), makeSession({ id: "s2" })], read);
  await vi.advanceTimersByTimeAsync(1);
  state.update("s", (session) => normalizeSessionTitles({ ...session, name: "我的名字", titleSource: "manual" }));
  state.update("s2", (session) => ({ ...session, agentSessionId: "thread-2" }));
  resolve({ "thread-1": "过时名称" });
  await vi.advanceTimersByTimeAsync(1);
  expect(state.sessions()[0].name).toBe("我的名字");
  expect(state.sessions()[1].nativeTitle).toBeUndefined();
  expect(read).toHaveBeenLastCalledWith(["thread-2"]);
});

it("cancels queued generation and rejects AI completion when a native title arrives", async () => {
  const state = start([makeSession({ titleGeneration: {
    prompt: "修复 bug", status: "generating", attempts: 1, requestId: "r",
  } })], vi.fn().mockResolvedValue({ "thread-1": "原生名称" }));
  await vi.advanceTimersByTimeAsync(1);
  state.update("s", (session) => completeSessionTitle(session, "r", { title: "AI 名称" }, Date.now()));
  expect(state.sessions()[0].name).toBe("原生名称");
  expect(state.sessions()[0].titleGeneration).toBeUndefined();
});

it("reads an inactive title once and does not keep a refresh timer for it", async () => {
  const read = vi.fn().mockResolvedValue({ "thread-1": "原生名称" });
  start([makeSession({ active: false })], read);
  await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(CODEX_TITLE_REFRESH_MS * 2);
  expect(read).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("retries read failures and ignores completions after shutdown", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let resolve!: (titles: Record<string, string>) => void;
  const read = vi.fn().mockRejectedValueOnce(new Error("unreadable"))
    .mockImplementationOnce(() => new Promise<Record<string, string>>((done) => { resolve = done; }));
  const state = start([makeSession()], read);
  await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(CODEX_MISSING_TITLE_REFRESH_MS);
  expect(read).toHaveBeenCalledTimes(2);
  stop?.();
  resolve({ "thread-1": "太晚的名称" });
  await vi.advanceTimersByTimeAsync(1);
  expect(state.sessions()[0].nativeTitle).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});
