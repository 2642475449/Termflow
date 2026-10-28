import { create } from "zustand";
import { persist } from "zustand/middleware";
import { configureVoiceGlobalShortcut } from "@/lib/api";
import { normalizeShortcutOverrides } from "@/lib/appShortcuts";
import type { ShortcutSettingsState } from "../types";

let recordingRequest = 0;

// 独立设置分片，避免继续扩展主 store；仅保存用户配置，录制状态不持久化。
export const useShortcutStore = create<ShortcutSettingsState>()(persist((set, get) => ({
  overrides: {},
  pendingOverrides: false,
  recordingAction: null,
  preparing: false,
  setShortcut: (action, keys) => set({
    overrides: normalizeShortcutOverrides({ ...get().overrides, [action]: keys }),
    pendingOverrides: true,
  }),
  // 恢复默认值应移除覆盖项；空字符串仍然明确表示禁用，不能当作默认值。
  setDefaultShortcut: (action) => {
    const overrides = { ...get().overrides };
    if (action) delete overrides[action];
    set({ overrides: action ? overrides : {}, pendingOverrides: true });
  },
  setOverrides: (value) => set({ overrides: normalizeShortcutOverrides(value), pendingOverrides: false }),
  setPersistedOverrides: (value) => {
    const overrides = normalizeShortcutOverrides(value);
    const current = get();
    const matches = JSON.stringify(overrides) === JSON.stringify(current.overrides);
    // 较早的保存响应或其他窗口的同步事件不能覆盖尚未保存的本地修改。
    if (current.pendingOverrides && !matches) return;
    set({ overrides: matches ? current.overrides : overrides, pendingOverrides: false });
  },
  setRecordingAction: async (action) => {
    const request = ++recordingRequest;
    set({ recordingAction: action, preparing: action !== null });
    if (action === null) return;
    try {
      // 系统语音快捷键先暂停，保证录制时 WebView 能收到原先被系统截获的组合键。
      await configureVoiceGlobalShortcut(null, false);
      if (request === recordingRequest) set({ preparing: false });
    } catch (error) {
      if (request === recordingRequest) set({ recordingAction: null, preparing: false });
      throw error;
    }
  },
}), {
  name: "termflow-shortcuts",
  partialize: (state) => ({ overrides: state.overrides }),
  merge: (saved, current) => ({
    ...current,
    overrides: normalizeShortcutOverrides((saved as { overrides?: unknown } | undefined)?.overrides),
  }),
}));
