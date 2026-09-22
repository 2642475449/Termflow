import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  completeWorkspaceClose, exitBackgroundApplication, getBackgroundSettings,
  setBackgroundSettings, type BackgroundSettings,
} from "@/lib/api";
import { useApplicationUpdateStore } from "./applicationUpdate";

interface BackgroundState {
  settings: BackgroundSettings;
  ready: boolean;
  busy: boolean;
  promptOpen: boolean;
  remember: boolean;
  setSettings: (settings: BackgroundSettings) => void;
  setRemember: (remember: boolean) => void;
  setPromptOpen: (open: boolean) => void;
}

export const useBackgroundStore = create<BackgroundState>()(persist((set) => ({
  settings: { runInBackground: false, askBeforeClose: true },
  ready: false,
  busy: false,
  promptOpen: false,
  remember: true,
  setSettings: (settings) => set({ settings, ready: true }),
  setRemember: (remember) => set({ remember }),
  setPromptOpen: (promptOpen) => set({ promptOpen }),
}), {
  name: "termflow-background-settings",
  partialize: ({ settings }) => ({ settings }),
}));

export async function refreshBackgroundSettings(): Promise<BackgroundSettings> {
  const settings = await getBackgroundSettings();
  useBackgroundStore.getState().setSettings(settings);
  return settings;
}

export async function saveBackgroundSettings(settings: BackgroundSettings): Promise<void> {
  useBackgroundStore.setState({ busy: true });
  try {
    await setBackgroundSettings(settings);
    useBackgroundStore.getState().setSettings(settings);
  } finally {
    useBackgroundStore.setState({ busy: false });
  }
}

// 下载更新时沿用原有关闭保护，避免销毁下载所属窗口。
function checkUpdateGuard(): void {
  const phase = useApplicationUpdateStore.getState().phase;
  if (phase === "downloading" || phase === "installing") throw new Error("application-update-in-progress");
}

export async function requestWorkspaceClose(exitApplication = false, explicitProjectClose = false): Promise<void> {
  const state = useBackgroundStore.getState();
  if (state.busy || (state.promptOpen && !exitApplication)) return;
  checkUpdateGuard();
  useBackgroundStore.setState({ busy: true });
  try {
    if (exitApplication) {
      await exitBackgroundApplication();
      return;
    }
    // 任务监控的项目关闭入口始终提供直接关闭选项，不覆盖全局后台偏好。
    if (explicitProjectClose) {
      useBackgroundStore.setState({ promptOpen: true, remember: false });
      return;
    }
    // SQLite 是多窗口设置的权威来源，关闭时不依赖旧窗口缓存。
    const settings = await refreshBackgroundSettings();
    if (settings.askBeforeClose) {
      useBackgroundStore.setState({ promptOpen: true, remember: true });
    } else {
      await completeWorkspaceClose(settings.runInBackground);
    }
  } finally {
    useBackgroundStore.setState({ busy: false });
  }
}

export async function chooseWorkspaceClose(background: boolean): Promise<void> {
  if (useBackgroundStore.getState().busy) return;
  checkUpdateGuard();
  useBackgroundStore.setState({ busy: true });
  try {
    if (useBackgroundStore.getState().remember) {
      const settings = { runInBackground: background, askBeforeClose: false };
      await setBackgroundSettings(settings);
      useBackgroundStore.getState().setSettings(settings);
    }
    await completeWorkspaceClose(background);
    useBackgroundStore.setState({ promptOpen: false });
  } finally {
    useBackgroundStore.setState({ busy: false });
  }
}
