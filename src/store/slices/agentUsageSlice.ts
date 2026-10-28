import { create } from "zustand";
import { usageFailureDelay, type AgentUsageSnapshot } from "@/lib/agentUsage";

export interface UsageView {
  value: AgentUsageSnapshot | null;
  loading: boolean;
  error: string | null;
  transportFailures: number;
  transportRetryAt: number;
}
export const EMPTY_USAGE_VIEW: UsageView = {
  value: null, loading: false, error: null, transportFailures: 0, transportRetryAt: 0,
};

interface AgentUsageState {
  views: Record<string, UsageView>;
  setResult: (key: string, value: AgentUsageSnapshot) => void;
  setLoading: (key: string, loading: boolean) => void;
  setError: (key: string, error: string) => void;
}

// 窗口内仅保存后端缓存的视图，Claude 按会话隔离，不写入工作区持久化。
export const useAgentUsageStore = create<AgentUsageState>((set) => ({
  views: {},
  setResult: (key, value) => set((state) => {
    const previous = state.views[key];
    if ((previous?.value?.checkedAt ?? 0) > (value.checkedAt ?? 0)) return state;
    return { views: { ...state.views, [key]: { ...EMPTY_USAGE_VIEW, value, loading: previous?.loading ?? false } } };
  }),
  setLoading: (key, loading) => set((state) => ({
    views: { ...state.views, [key]: { ...(state.views[key] ?? EMPTY_USAGE_VIEW), loading } },
  })),
  setError: (key, error) => set((state) => {
    const previous = state.views[key] ?? EMPTY_USAGE_VIEW;
    const transportFailures = previous.transportFailures + 1;
    return { views: { ...state.views, [key]: {
      ...previous, error, transportFailures,
      transportRetryAt: Date.now() + usageFailureDelay(transportFailures),
    } } };
  }),
}));
