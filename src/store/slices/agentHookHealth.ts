import { create } from "zustand";
import { ensureAgentStatusHook, type AgentHookStatus } from "@/lib/api";

export type CodexHookHealth = "unknown" | "pending" | "observed" | "disabled" | "error";

interface AgentHookHealthState {
  status: CodexHookHealth;
  configurationId?: string;
  configPath?: string;
  observedAt?: number;
  error?: string;
  checking: boolean;
  setConfiguration: (status: AgentHookStatus) => void;
  setObserved: (receivedAt: number) => void;
  setError: (error: string) => void;
  setCheck: () => Promise<void>;
}

// 仅保存本次应用运行收到的回调证据，不把上一次运行当作当前配置已生效。
export const useAgentHookHealthStore = create<AgentHookHealthState>((set, get) => ({
  status: "unknown",
  checking: false,
  setConfiguration: (result) => {
    if (result.agent !== "codex") return;
    const activation = result.codexActivation;
    const sameConfiguration = activation?.configurationId === get().configurationId;
    const observedAt = result.configured && !activation?.disabled && sameConfiguration
      ? get().observedAt
      : undefined;
    set({
      status: !result.configured ? "error" : activation?.disabled ? "disabled" : observedAt ? "observed" : "pending",
      configurationId: activation?.configurationId,
      configPath: result.configPath,
      observedAt: activation?.disabled ? undefined : observedAt,
      error: result.configured ? undefined : result.detail ?? undefined,
    });
  },
  setObserved: (receivedAt) => {
    // 禁用配置下旧会话的回调不能使新会话的检查转绿。
    if (get().status === "disabled" || get().status === "error") return;
    set({ status: "observed", observedAt: receivedAt });
  },
  setError: (error) => set({ status: "error", error, observedAt: undefined }),
  setCheck: async () => {
    if (get().checking) return;
    set({ checking: true });
    try {
      get().setConfiguration(await ensureAgentStatusHook("codex"));
    } catch (error) {
      get().setError(error instanceof Error ? error.message : String(error));
    } finally {
      set({ checking: false });
    }
  },
}));
