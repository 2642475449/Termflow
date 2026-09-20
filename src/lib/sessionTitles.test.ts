import { afterEach, expect, it, vi } from "vitest";
import type { Session } from "@/types";
import { completeSessionTitle, normalizeSessionTitles, queueSessionTitle, startTitleGeneration } from "./sessionTitles";
import { updateSessionCollection } from "@/store/utils/session";
import { toPersistedSession } from "./sessions";

const session = (patch: Partial<Session> = {}): Session => ({
  id: "s1", path: "E:/project", name: "会话 12:00", active: true, createdAt: 1, agentId: "codex", ...patch,
});
afterEach(() => vi.useRealTimers());

it("migrates old auto titles conservatively without locking future generation", () => {
  const old = session({ titleSource: "auto", name: "你好士大夫", firstPromptTitle: "你好士大夫" });
  expect(normalizeSessionTitles(old).generatedTitle).toBeUndefined();
  expect(queueSessionTitle(old, "检查系统 bug").titleGeneration?.status).toBe("pending");
});

it("queues model generation even when a path cannot form a temporary title", () => {
  const next = queueSessionTitle(session(), "C:/Users/test/screenshot.png");
  expect(next.temporaryTitle).toBeUndefined();
  expect(next.name).toBe("会话 12:00");
  expect(next.titleGeneration?.status).toBe("pending");
});

it("stores temporary, generated and manual titles independently", () => {
  let current = queueSessionTitle(session(), "请帮我修复登录问题");
  current.titleGeneration = { ...current.titleGeneration!, status: "generating", attempts: 1, requestId: "r1" };
  current = completeSessionTitle(current, "r1", { title: "登录流程修复" }, 0);
  expect(current.temporaryTitle).toBe("修复登录问题");
  expect(current.generatedTitle).toBe("登录流程修复");
  expect(current.name).toBe("登录流程修复");
  current = updateSessionCollection([current], current.id, { name: "手动名字", titleSource: "manual" })[0];
  expect(current.manualTitle).toBe("手动名字");
  expect(current.generatedTitle).toBe("登录流程修复");
  expect(current.name).toBe("手动名字");
});

it("rejects stale responses and responses arriving after a manual rename", () => {
  const current = session({ titleGeneration: { prompt: "test", status: "generating", attempts: 1, requestId: "new" } });
  expect(completeSessionTitle(current, "old", { title: "新标题" }, 0)).toBe(current);
  const manual = updateSessionCollection([current], current.id, { name: "我的标题", titleSource: "manual" })[0];
  expect(completeSessionTitle(manual, "new", { title: "新标题" }, 0)).toBe(manual);
});

it("preserves the failure reason, limits automatic retries and allows a new prompt", () => {
  const current = queueSessionTitle(session(), "检查系统 bug");
  current.titleGeneration = { ...current.titleGeneration!, status: "generating", attempts: 3, requestId: "r" };
  const failed = completeSessionTitle(current, "r", { error: "Claude timed out" }, 100);
  expect(failed.titleGeneration).toMatchObject({ status: "failed", error: "Claude timed out", attempts: 3 });
  expect(failed.titleGeneration?.nextRetryAt).toBeUndefined();
  expect(failed.name).toBe(current.name);
  expect(queueSessionTitle(failed, "修复登录问题").titleGeneration).toMatchObject({ status: "pending", attempts: 0 });
});

it("persists title sources and retry metadata in the session snapshot", () => {
  const current = session({ temporaryTitle: "临时标题", titleGeneration: {
    prompt: "检查系统", status: "failed", attempts: 1, error: "timeout", nextRetryAt: 20000,
  } });
  const restored = JSON.parse(JSON.stringify(toPersistedSession(current))) as Session;
  expect(restored.temporaryTitle).toBe("临时标题");
  expect(restored.titleGeneration).toEqual(current.titleGeneration);
});

it("retries in the background after failure, then replaces only the temporary display", async () => {
  vi.useFakeTimers();
  let current = queueSessionTitle(session(), "检查系统 bug");
  const generate = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("系统缺陷排查");
  const stop = startTitleGeneration({
    sessions: () => [current], update: (_, change) => { current = change(current); },
    generate, subscribe: () => () => {},
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(current.titleGeneration?.error).toBe("offline");
  expect(current.generatedTitle).toBeUndefined();
  await vi.advanceTimersByTimeAsync(20_001);
  expect(generate).toHaveBeenCalledTimes(2);
  expect(current.name).toBe("系统缺陷排查");
  expect(current.titleGeneration).toMatchObject({ status: "succeeded", attempts: 2 });
  expect(current.titleGeneration?.error).toBeUndefined();
  stop();
});

it("recovers interrupted persisted requests and ignores completion after shutdown", async () => {
  vi.useFakeTimers();
  let current = session({ titleGeneration: { prompt: "修复 bug", status: "generating", attempts: 1, requestId: "old" } });
  let resolve!: (title: string) => void;
  const generate = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
  const stop = startTitleGeneration({ sessions: () => [current],
    update: (_, change) => { current = change(current); }, generate, subscribe: () => () => {},
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(generate).toHaveBeenCalledOnce();
  expect(current.titleGeneration?.requestId).not.toBe("old");
  stop();
  resolve("系统修复");
  await Promise.resolve();
  expect(current.generatedTitle).toBeUndefined();
});
