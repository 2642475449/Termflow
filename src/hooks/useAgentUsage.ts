import { useCallback, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getAntigravityUsage, getClaudeRateLimits, getCodexRateLimits, getQoderUsage, isUsageWindowVisible } from "@/lib/api";
import { usageMonitorDelay, usageViewKey, type AgentUsageSnapshot, type UsageAgentId, type UsageDataByAgent } from "@/lib/agentUsage";
import { EMPTY_USAGE_VIEW, useAgentUsageStore } from "@/store/slices/agentUsageSlice";
import type { ClaudeRateLimitsUpdatePayload } from "@/types";

const USAGE_EVENTS: Record<UsageAgentId, string> = {
  codex: "codex-rate-limits-updated", claude: "claude-rate-limits-update",
  qoder: "qoder-usage-updated", antigravity: "antigravity-usage-updated",
};

function requestUsage(agent: UsageAgentId, sessionId: string | undefined, forceRefresh: boolean): Promise<AgentUsageSnapshot> {
  switch (agent) {
    case "codex": return getCodexRateLimits({ forceRefresh });
    case "qoder": return getQoderUsage({ forceRefresh });
    case "antigravity": return getAntigravityUsage({ forceRefresh });
    case "claude": return getClaudeRateLimits(sessionId ?? "", { forceRefresh });
  }
}

const pendingLoads = new Map<string, Promise<void>>();

export async function refreshAgentUsage(agent: UsageAgentId, sessionId?: string, manual = false): Promise<void> {
  const key = usageViewKey(agent, sessionId);
  const state = useAgentUsageStore.getState();
  if (!manual && (state.views[key]?.transportRetryAt ?? 0) > Date.now()) return;
  let request = pendingLoads.get(key);
  if (!request) {
    const originalValue = state.views[key]?.value ?? null;
    state.setLoading(key, true);
    request = requestUsage(agent, sessionId, manual).then((value) => {
      state.setResult(key, value);
    }).catch((error: unknown) => {
      // 已收到更新的推送时，不让旧请求的错误盖住新数据。
      if ((useAgentUsageStore.getState().views[key]?.value ?? null) === originalValue) {
        state.setError(key, error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      pendingLoads.delete(key);
      state.setLoading(key, false);
    });
    pendingLoads.set(key, request);
  }
  await request;
}

export function useAgentUsage<Agent extends UsageAgentId>(agent: Agent, enabled: boolean, sessionId?: string) {
  const key = usageViewKey(agent, sessionId);
  const view = useAgentUsageStore((state) => state.views[key] ?? EMPTY_USAGE_VIEW);

  const load = useCallback(async (manual: boolean) => {
    if (enabled) await refreshAgentUsage(agent, sessionId, manual);
  }, [agent, enabled, sessionId]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (disposed || document.visibilityState === "hidden") return;
      const current = useAgentUsageStore.getState().views[key] ?? EMPTY_USAGE_VIEW;
      timer = setTimeout(() => { void tick(); }, usageMonitorDelay(current.value, Date.now(), current.transportRetryAt));
    };
    const tick = async () => {
      clearTimeout(timer);
      if (disposed || running || document.visibilityState === "hidden") return;
      running = true;
      let visible = false;
      try {
        visible = await isUsageWindowVisible();
        if (visible && !disposed) await load(false);
      } finally {
        running = false;
        if (visible) schedule();
      }
    };
    const onVisible = () => { void tick(); };
    const unlisten = listen<AgentUsageSnapshot | ClaudeRateLimitsUpdatePayload>(USAGE_EVENTS[agent], ({ payload }) => {
      if (disposed || (agent === "claude" && (!("sessionId" in payload) || payload.sessionId !== sessionId))) return;
      useAgentUsageStore.getState().setResult(key, payload);
    }).catch((error) => { console.error("Failed to listen for agent usage:", error); return () => {}; });
    const unsubscribe = useAgentUsageStore.subscribe((state, previous) => {
      if (state.views[key] !== previous.views[key]) schedule();
    });
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    void tick();
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      void unlisten.then((stop) => stop());
    };
  }, [agent, enabled, key, load, sessionId]);

  // key 由 agent 生成，存入的结果来自对应提供方，Claude 还包含 sessionId。
  return { value: view.value as UsageDataByAgent[Agent] | null, loading: view.loading,
    error: view.error, refresh: () => { void load(true); } };
}
