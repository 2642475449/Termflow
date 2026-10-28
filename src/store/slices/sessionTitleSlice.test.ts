import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppStore, createAppStore } from "@/store";
import * as api from "@/lib/api";
import { setSessionTitlePrompt, startSessionTitleGeneration, retrySessionTitle } from "./sessionTitleSlice";

let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.getState().setCurrentProject({ name: "A", path: "E:/A" });
  useAppStore.getState().addSession({ id: "a", path: "E:/A", name: "会话", createdAt: 1, active: true, agentId: "claude" });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("writes completion to the owning project and tab after switching projects", async () => {
  let resolve!: (title: string) => void;
  vi.spyOn(api, "generateSessionTitle").mockImplementation(() => new Promise<string>((done) => { resolve = done; }));
  setSessionTitlePrompt("a", "检查系统 bug");
  stop = startSessionTitleGeneration();
  await vi.advanceTimersByTimeAsync(1);
  useAppStore.getState().setCurrentProject({ name: "B", path: "E:/B" });
  useAppStore.getState().addSession({ id: "b", path: "E:/B", name: "B 会话", createdAt: 2, active: true });
  resolve("系统缺陷排查");
  await vi.advanceTimersByTimeAsync(1);
  const state = useAppStore.getState();
  expect(state.projectSessions["E:/A"][0].name).toBe("系统缺陷排查");
  expect(state.projectWorkspaces["E:/A"].tabsById.a.title).toBe("系统缺陷排查");
  expect(state.sessions[0].name).toBe("B 会话");
  expect(state.tabsById.b.title).toBe("B 会话");
});

it("protects a manual rename from both completion and explicit retry", async () => {
  let resolve!: (title: string) => void;
  const generate = vi.spyOn(api, "generateSessionTitle").mockImplementation(() => new Promise<string>((done) => { resolve = done; }));
  setSessionTitlePrompt("a", "检查系统 bug");
  stop = startSessionTitleGeneration();
  await vi.advanceTimersByTimeAsync(1);
  useAppStore.getState().updateSession("a", { name: "我的名字", titleSource: "manual" });
  resolve("系统缺陷排查");
  await vi.advanceTimersByTimeAsync(1);
  retrySessionTitle("a");
  await vi.advanceTimersByTimeAsync(1);
  expect(useAppStore.getState().sessions[0].manualTitle).toBe("我的名字");
  expect(useAppStore.getState().tabsById.a.title).toBe("我的名字");
  expect(generate).toHaveBeenCalledOnce();
});

it("round-trips retry state and separate titles through actual Zustand persistence", () => {
  let saved: string | null = null;
  const storage = { getItem: () => saved, setItem: (_: string, value: string) => { saved = value; }, removeItem: () => {} };
  const store = createAppStore(storage);
  store.getState().setCurrentProject({ name: "A", path: "E:/A" });
  store.getState().addSession({ id: "a", path: "E:/A", name: "临时标题", createdAt: 1, active: true,
    titleSource: "auto", temporaryTitle: "临时标题", titleGeneration: {
      prompt: "检查系统 bug", status: "failed", attempts: 2, error: "offline", nextRetryAt: 12345,
    },
  });
  const restored = createAppStore(storage).getState().projectSessions["E:/A"][0];
  expect(restored.temporaryTitle).toBe("临时标题");
  expect(restored.generatedTitle).toBeUndefined();
  expect(restored.titleGeneration).toMatchObject({ status: "failed", error: "offline", attempts: 2, nextRetryAt: 12345 });
});

it("syncs the Codex native title to the owning project's session and tab without launching AI", async () => {
  let resolve!: (titles: Record<string, string>) => void;
  const read = vi.spyOn(api, "readCodexSessionTitles").mockImplementation(() => new Promise((done) => { resolve = done; }));
  const generate = vi.spyOn(api, "generateSessionTitle").mockResolvedValue("不应生成");
  useAppStore.getState().updateSession("a", { agentId: "codex", agentSessionId: "thread-a" });
  setSessionTitlePrompt("a", "修复登录问题");
  stop = startSessionTitleGeneration();
  await vi.advanceTimersByTimeAsync(1);
  useAppStore.getState().setCurrentProject({ name: "B", path: "E:/B" });
  resolve({ "thread-a": "Codex 原生：登录流程修复" });
  await vi.advanceTimersByTimeAsync(60_001);
  const state = useAppStore.getState();
  expect(read).toHaveBeenCalledWith(["thread-a"]);
  expect(generate).not.toHaveBeenCalled();
  expect(state.projectSessions["E:/A"][0].name).toBe("Codex 原生：登录流程修复");
  expect(state.projectWorkspaces["E:/A"].tabsById.a.title).toBe("Codex 原生：登录流程修复");
  expect(state.sessions).toEqual([]);
});

it("round-trips native Codex names and AI fallback deadlines through Zustand persistence", () => {
  let saved: string | null = null;
  const storage = { getItem: () => saved, setItem: (_: string, value: string) => { saved = value; }, removeItem: () => {} };
  const store = createAppStore(storage);
  store.getState().setCurrentProject({ name: "A", path: "E:/A" });
  store.getState().addSession({ id: "a", path: "E:/A", name: "原生名称", createdAt: 1, active: true,
    agentId: "codex", agentSessionId: "thread-a", nativeTitle: { sessionId: "thread-a", title: "原生名称" },
    temporaryTitle: "临时名称", titleGeneration: {
      prompt: "检查系统 bug", status: "pending", attempts: 0, notBefore: 12345,
    },
  });
  const restored = createAppStore(storage).getState().projectSessions["E:/A"][0];
  expect(restored.nativeTitle).toEqual({ sessionId: "thread-a", title: "原生名称" });
  expect(restored.name).toBe("原生名称");
  expect(restored.titleGeneration?.notBefore).toBe(12345);
});
