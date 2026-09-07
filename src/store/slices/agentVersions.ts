import { create } from "zustand";
import { checkAgentLatestVersion } from "@/lib/api";
import { AI_AGENT_ORDER } from "@/lib/agents";
import type { AiAgentId } from "@/types";

export interface AgentVersionCheck {
  status: "checking" | "success" | "error";
  latest?: string;
  checkedAt?: number;
}

interface AgentVersionsState {
  versions: Partial<Record<AiAgentId, AgentVersionCheck>>;
  setVersionChecks: (force?: boolean) => Promise<void>;
}

const CACHE_TTL_MS = 30 * 60 * 1000;

// 网络结果仅存内存；失败可立即重试，不写入用户持久化设置。
export const useAgentVersionsStore = create<AgentVersionsState>((set, get) => ({
  versions: {},
  setVersionChecks: async (force = false) => {
    await Promise.all(AI_AGENT_ORDER.map(async (agentId) => {
      const current = get().versions[agentId];
      if (current?.status === "checking") return;
      if (!force && current?.status === "success" && Date.now() - (current.checkedAt ?? 0) < CACHE_TTL_MS) return;
      const update = (value: AgentVersionCheck) => set((state) => ({ versions: { ...state.versions, [agentId]: value } }));
      update({ status: "checking" });
      try {
        const latest = await checkAgentLatestVersion(agentId);
        update({ status: "success", latest, checkedAt: Date.now() });
      } catch {
        update({ status: "error" });
      }
    }));
  },
}));
