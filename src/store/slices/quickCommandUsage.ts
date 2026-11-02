import { create } from "zustand";
import { persist } from "zustand/middleware";
import { loadQuickCommandUsage, recordQuickCommandUse } from "@/lib/api";
import type { QuickCommandUsage } from "@/types";
import type { QuickCommandUsageState } from "../types";

function normalizeUsage(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, timestamp]) =>
    id.length > 0 && typeof timestamp === "number" && Number.isSafeInteger(timestamp) && timestamp > 0,
  ));
}

function normalizeUsageByProject(value: unknown): QuickCommandUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([path]) => path.length > 0)
    .map(([path, usage]) => [path, normalizeUsage(usage)]));
}

// 使用记录独立落库，不进入项目的 quick-commands.json 或通用设置的 250ms 快照同步。
export const useQuickCommandUsageStore = create<QuickCommandUsageState>()(persist((set, get) => ({
  usageByProject: {},
  setProjectUsage: (projectPath, usage) => set((state) => {
    const previous = Object.prototype.hasOwnProperty.call(state.usageByProject, projectPath) ? state.usageByProject[projectPath] : {};
    // 读取或写入响应可能晚到，逐条取较新时间，避免覆盖正在发生的使用。
    const merged = new Map(Object.entries(previous));
    for (const [id, timestamp] of Object.entries(normalizeUsage(usage))) {
      merged.set(id, Math.max(merged.get(id) ?? 0, timestamp));
    }
    return { usageByProject: { ...state.usageByProject, [projectPath]: Object.fromEntries(merged) } };
  }),
  setCommandUsed: async (projectPath, commandId) => {
    const usedAt = Date.now();
    try {
      get().setProjectUsage(projectPath, { [commandId]: usedAt });
    } catch (error) {
      console.warn("Failed to cache quick command usage:", error);
    }
    try {
      const savedAt = await recordQuickCommandUse(projectPath, commandId, usedAt);
      get().setProjectUsage(projectPath, { [commandId]: savedAt });
    } catch (error) {
      // 启动已成功，保留本机缓存；记录失败不能误报为命令启动失败。
      console.warn("Failed to persist quick command usage:", error);
    }
  },
}), {
  name: "termflow-quick-command-usage",
  partialize: ({ usageByProject }) => ({ usageByProject }),
  merge: (saved, current) => ({
    ...current,
    usageByProject: normalizeUsageByProject((saved as { usageByProject?: unknown } | undefined)?.usageByProject),
  }),
}));

export async function refreshQuickCommandUsage(projectPath: string): Promise<void> {
  try {
    const usage = await loadQuickCommandUsage(projectPath);
    useQuickCommandUsageStore.getState().setProjectUsage(projectPath, usage);
  } catch (error) {
    console.warn("Failed to load quick command usage:", error);
  }
}
