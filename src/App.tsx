import { useEffect, useMemo, useRef, useState } from "react";
import { App as AntdApp, ConfigProvider, theme } from "antd";
import { listen } from "@tauri-apps/api/event";
import zhCN from "antd/locale/zh_CN";
import zhTW from "antd/locale/zh_TW";
import enUS from "antd/locale/en_US";
import jaJP from "antd/locale/ja_JP";
import AppLayout from "./components/layout/AppLayout";
import VoiceOverlayWindow from "./components/VoiceOverlayWindow";
import VoiceWorkerWindow from "./components/VoiceWorkerWindow";
import {
  applyPersistentSettingsToStore,
  getPersistentSettingsSnapshot,
  useAppStore,
  type ThemeMode,
} from "./store";
import {
  initializePersistentSettings,
  savePersistentSettings,
  setClaudeTheme,
} from "./lib/api";
import i18n, { toI18nLanguage } from "./i18n";
import { useRecentProjectSync } from "./hooks/useRecentProjectSync";
import { TOAST_NOTIFICATION_CONFIG, ToastHost } from "./lib/toast";

const THEME_COLORS: Record<ThemeMode, string> = {
  "light-glass": "#4f6cf7",
  "light-warm": "#c2713a",
  "dark-starry": "#5c7ba3",
  "dark-mocha": "#f5bd69",
};

const STARTUP_THEME_STORAGE_KEY = "termflow-startup-theme";
const PERSISTENT_THEME_UPDATED_EVENT = "persistent-theme-updated";

interface PersistentThemeUpdate {
  lightTheme: ThemeMode;
  darkTheme: ThemeMode;
  themeCategory: "light" | "dark" | "system";
}

function isPersistentThemeUpdate(value: unknown): value is PersistentThemeUpdate {
  if (!value || typeof value !== "object") {
    return false;
  }

  const update = value as Record<string, unknown>;
  const isThemeMode = (theme: unknown): theme is ThemeMode =>
    theme === "light-glass" ||
    theme === "light-warm" ||
    theme === "dark-starry" ||
    theme === "dark-mocha";

  return (
    isThemeMode(update.lightTheme) &&
    isThemeMode(update.darkTheme) &&
    (update.themeCategory === "light" ||
      update.themeCategory === "dark" ||
      update.themeCategory === "system")
  );
}

function App() {
  const lightTheme = useAppStore((s) => s.lightTheme);
  const darkTheme = useAppStore((s) => s.darkTheme);
  const themeCategory = useAppStore((s) => s.themeCategory);
  const currentProject = useAppStore((s) => s.currentProject);
  const lastProject = useAppStore((s) => s.lastProject);
  const language = useAppStore((s) => s.language);
  const startupRestoreLastProject = useAppStore((s) => s.startupRestoreLastProject);
  const projectOpenBehavior = useAppStore((s) => s.projectOpenBehavior);
  const systemPrefersDark = useAppStore((s) => s.systemPrefersDark);
  const setSystemPrefersDark = useAppStore((s) => s.setSystemPrefersDark);
  const editorFontSize = useAppStore((s) => s.editorFontSize);
  const terminalFontSize = useAppStore((s) => s.terminalFontSize);
  const terminalCursorBlink = useAppStore((s) => s.terminalCursorBlink);
  const terminalLineHeight = useAppStore((s) => s.terminalLineHeight);
  const terminalRenderer = useAppStore((s) => s.terminalRenderer);
  const terminalQuickCommands = useAppStore((s) => s.terminalQuickCommands);
  const defaultAgentId = useAppStore((s) => s.defaultAgentId);
  const agentPermissionDefaults = useAppStore((s) => s.agentPermissionDefaults);
  const notificationEnabled = useAppStore((s) => s.notificationEnabled);
  const notificationSoundEnabled = useAppStore((s) => s.notificationSoundEnabled);
  const notificationSoundMap = useAppStore((s) => s.notificationSoundMap);
  const notificationThresholdMs = useAppStore((s) => s.notificationThresholdMs);
  const feishuNotificationEnabled = useAppStore((s) => s.feishuNotificationEnabled);
  const feishuNotificationThresholdMs = useAppStore((s) => s.feishuNotificationThresholdMs);
  const feishuNotificationEvents = useAppStore((s) => s.feishuNotificationEvents);
  const asrApiKey = useAppStore((s) => s.asrApiKey);
  const asrAuthMode = useAppStore((s) => s.asrAuthMode);
  const asrModel = useAppStore((s) => s.asrModel);
  const asrRegion = useAppStore((s) => s.asrRegion);
  const voiceShortcut = useAppStore((s) => s.voiceShortcut);
  const voiceInputTarget = useAppStore((s) => s.voiceInputTarget);
  const voiceTriggerVisible = useAppStore((s) => s.voiceTriggerVisible);
  const projectPath = currentProject?.path ?? null;
  const [persistentSettingsReady, setPersistentSettingsReady] = useState(false);
  const lastPersistedSnapshotRef = useRef<string | null>(null);

  useEffect(() => {
    const preventNativeContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };
    document.addEventListener("contextmenu", preventNativeContextMenu);
    return () => {
      document.removeEventListener("contextmenu", preventNativeContextMenu);
    };
  }, []);

  const isDark =
    themeCategory === "dark" ||
    (themeCategory === "system" && systemPrefersDark);

  const currentTheme = isDark ? darkTheme : lightTheme;
  const primaryColor = THEME_COLORS[currentTheme];
  const persistentSettings = useMemo(
    () => ({
      lightTheme,
      darkTheme,
      themeCategory,
      language,
      startupRestoreLastProject,
      projectOpenBehavior,
      lastProjectPath: lastProject?.path ?? null,
      editorFontSize,
      terminalFontSize,
      terminalCursorBlink,
      terminalLineHeight,
      terminalRenderer,
      terminalQuickCommands,
      defaultAgentId,
      agentPermissionDefaults,
      notificationEnabled,
      notificationSoundEnabled,
      notificationSoundMap,
      notificationThresholdMs,
      feishuNotificationEnabled,
      feishuNotificationThresholdMs,
      feishuNotificationEvents,
      asrApiKey,
      asrAuthMode,
      asrModel,
      asrRegion,
      voiceShortcut,
      voiceInputTarget,
      voiceTriggerVisible,
    }),
    [
      asrApiKey,
      asrAuthMode,
      asrModel,
      asrRegion,
      darkTheme,
      editorFontSize,
      language,
      lastProject?.path,
      lightTheme,
      notificationEnabled,
      notificationSoundEnabled,
      notificationSoundMap,
      notificationThresholdMs,
      feishuNotificationEnabled,
      feishuNotificationThresholdMs,
      feishuNotificationEvents,
      agentPermissionDefaults,
      startupRestoreLastProject,
      projectOpenBehavior,
      terminalCursorBlink,
      terminalFontSize,
      terminalLineHeight,
      terminalRenderer,
      terminalQuickCommands,
      defaultAgentId,
      themeCategory,
      voiceInputTarget,
      voiceShortcut,
      voiceTriggerVisible,
    ]
  );
  const isVoiceOverlayWindow =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("overlay") === "voice";
  const isVoiceWorkerWindow =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("worker") === "voice";

  useRecentProjectSync(!isVoiceOverlayWindow && !isVoiceWorkerWindow);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", currentTheme);
    try {
      localStorage.setItem(
        STARTUP_THEME_STORAGE_KEY,
        JSON.stringify({ lightTheme, darkTheme, themeCategory })
      );
    } catch (error) {
      console.warn("Failed to cache the startup theme:", error);
    }
  }, [currentTheme, darkTheme, lightTheme, themeCategory]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    // 同步初始值
    setSystemPrefersDark(mq.matches);
    // 监听变化
    const handler = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [setSystemPrefersDark]);

  useEffect(() => {
    if (themeCategory !== "system") return;
    // 系统主题变化时自动同步 Claude Code
    setClaudeTheme(systemPrefersDark ? "dark" : "light", projectPath).catch((error) => {
      console.error("Failed to sync Claude theme on system change:", error);
    });
  }, [projectPath, systemPrefersDark, themeCategory]);

  useEffect(() => {
    if (isVoiceOverlayWindow) {
      return;
    }

    let disposed = false;
    initializePersistentSettings(getPersistentSettingsSnapshot())
      .then((settings) => {
        if (!disposed) {
          applyPersistentSettingsToStore(settings);
          lastPersistedSnapshotRef.current = JSON.stringify(settings);
          setPersistentSettingsReady(true);
        }
      })
      .catch((error) => {
        console.error("Failed to initialize persistent settings from SQLite:", error);
      });

    return () => {
      disposed = true;
    };
  }, [isVoiceOverlayWindow, isVoiceWorkerWindow]);

  useEffect(() => {
    if (isVoiceOverlayWindow || !persistentSettingsReady) {
      return;
    }

    const serialized = JSON.stringify(persistentSettings);
    if (serialized === lastPersistedSnapshotRef.current) {
      return;
    }

    const timer = window.setTimeout(() => {
      savePersistentSettings(persistentSettings)
        .then(() => {
          lastPersistedSnapshotRef.current = serialized;
        })
        .catch((error) => {
          console.error("Failed to persist settings to SQLite:", error);
        });
    }, 250);

    return () => {
      window.clearTimeout(timer);
    };
  }, [isVoiceOverlayWindow, persistentSettings, persistentSettingsReady]);

  useEffect(() => {
    if (!persistentSettingsReady) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    listen<unknown>(PERSISTENT_THEME_UPDATED_EVENT, (event) => {
      if (!isPersistentThemeUpdate(event.payload)) {
        return;
      }

      useAppStore.setState(event.payload);
      // This update originated in another window and is already in SQLite. Mark
      // it as persisted locally so it does not overwrite unrelated settings.
      lastPersistedSnapshotRef.current = JSON.stringify(getPersistentSettingsSnapshot());
    })
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      })
      .catch((error) => {
        console.error("Failed to listen for persistent theme updates:", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [persistentSettingsReady]);

  useEffect(() => {
    if (isVoiceOverlayWindow) {
      document.documentElement.setAttribute("data-overlay", "voice");
    } else {
      document.documentElement.removeAttribute("data-overlay");
    }
  }, [isVoiceOverlayWindow]);

  useEffect(() => {
    const nextLanguage = toI18nLanguage(language);
    if (i18n.language !== nextLanguage) {
      void i18n.changeLanguage(nextLanguage);
    }
    document.documentElement.setAttribute("lang", nextLanguage);
  }, [language]);

  const antdLocale = language === "en" ? enUS : language === "zh_TW" ? zhTW : language === "ja" ? jaJP : zhCN;

  return (
    <ConfigProvider
      locale={antdLocale}
      theme={{
        algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: primaryColor,
          borderRadius: 6,
        },
      }}
    >
      <AntdApp notification={TOAST_NOTIFICATION_CONFIG}>
        <ToastHost />
        {isVoiceOverlayWindow ? (
          <VoiceOverlayWindow />
        ) : isVoiceWorkerWindow ? (
          <VoiceWorkerWindow />
        ) : (
          <AppLayout />
        )}
      </AntdApp>
    </ConfigProvider>
  );
}

export default App;
