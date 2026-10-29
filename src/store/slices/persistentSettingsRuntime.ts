import { PersistentSettingsSync } from "@/lib/persistentSettingsSync";
import type { PersistentSettings } from "@/types";
import { getPersistentSettingsSnapshot } from "@/store";
import { useShortcutStore } from "./shortcutSlice";
import { useAuxiliaryDockStore } from "../auxiliaryDock";

// 每个 WebView 各自持有落库基线，让防抖保存和安装更新前的保存共用同一队列。
export const persistentSettingsSync = new PersistentSettingsSync<PersistentSettings>();

export function getRuntimePersistentSettingsSnapshot(): PersistentSettings {
  return {
    ...getPersistentSettingsSnapshot(),
    keyboardShortcuts: useShortcutStore.getState().overrides,
    auxiliaryDockWidth: useAuxiliaryDockStore.getState().width,
  };
}
