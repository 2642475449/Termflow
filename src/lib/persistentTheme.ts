import { listen } from "@tauri-apps/api/event";
import { getPersistentSettings } from "./api";
import type { ThemeMode } from "@/store/types";

export const PERSISTENT_THEME_UPDATED_EVENT = "persistent-theme-updated";

export interface PersistentThemeUpdate {
  lightTheme: ThemeMode;
  darkTheme: ThemeMode;
  themeCategory: "light" | "dark" | "system";
}

export function isPersistentThemeUpdate(value: unknown): value is PersistentThemeUpdate {
  if (!value || typeof value !== "object") return false;
  const update = value as Record<string, unknown>;
  const isThemeMode = (theme: unknown): theme is ThemeMode =>
    theme === "light-glass" || theme === "light-warm" ||
    theme === "dark-starry" || theme === "dark-mocha";
  return isThemeMode(update.lightTheme) && isThemeMode(update.darkTheme) &&
    (update.themeCategory === "light" || update.themeCategory === "dark" ||
      update.themeCategory === "system");
}

/** 悬浮窗只读取主题，不参与主窗口的设置初始化和回写。 */
export function startVoiceOverlayThemeSync(
  applyTheme: (theme: PersistentThemeUpdate) => void,
): () => void {
  let disposed = false;
  let revision = 0;
  let unlisten: (() => void) | undefined;
  const apply = (value: unknown) => {
    if (disposed || !isPersistentThemeUpdate(value)) return;
    const { lightTheme, darkTheme, themeCategory } = value;
    applyTheme({ lightTheme, darkTheme, themeCategory });
  };

  const initialize = async () => {
    // 先订阅再读取，避免加载过程中漏掉主题切换。
    try {
      const stop = await listen<unknown>(PERSISTENT_THEME_UPDATED_EVENT, ({ payload }) => {
        if (disposed || !isPersistentThemeUpdate(payload)) return;
        revision += 1;
        apply(payload);
      });
      if (disposed) {
        stop();
        return;
      }
      unlisten = stop;
    } catch (error) {
      console.error("Failed to listen for voice overlay theme updates:", error);
    }
    if (disposed) return;
    const initialRevision = revision;
    try {
      const settings = await getPersistentSettings();
      // 读取期间收到的新主题优先于旧快照。
      if (revision === initialRevision) apply(settings);
    } catch (error) {
      console.error("Failed to load voice overlay theme:", error);
    }
  };
  void initialize();
  return () => {
    disposed = true;
    unlisten?.();
  };
}
