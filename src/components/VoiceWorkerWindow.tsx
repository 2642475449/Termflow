import type { VoicePolishConfig } from "@/lib/voicePolish";
import { useEffect, useMemo, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { useVoiceRecognition, type AsrPhase } from "@/hooks/useVoiceRecognition";
import type { MimoAuthMode } from "@/lib/mimoAsr";
import {
  ensureVoiceOverlayWindow,
  hideVoiceOverlayWindow,
  sendTextToFocusedWindow,
} from "@/lib/api";
import { useAppStore } from "@/store";
import i18n from "@/i18n";

type VoiceWorkerAction = "press" | "release" | "toggle" | "cancel";
type VoiceInputTarget = "terminal" | "system";

const VOICE_OVERLAY_REASSERT_INTERVAL_MS = 600;

interface VoiceWorkerConfigPayload {
  apiKey: string;
  authMode: MimoAuthMode;
  model: string;
  region?: "beijing" | "singapore" | "us";
  polishEnabled: boolean;
  polishModel: string;
  polishProvider: VoicePolishConfig["provider"];
  polishApiKey: VoicePolishConfig["apiKey"];
  polishAuthMode: VoicePolishConfig["authMode"];
  polishRegion: VoicePolishConfig["region"];
  polishStyle: VoicePolishConfig["style"];
  shortcut: string;
  inputTarget: VoiceInputTarget;
}

interface VoiceWorkerControlPayload {
  action: VoiceWorkerAction;
}

interface VoiceWorkerStatePayload {
  phase: AsrPhase;
  level: number;
  elapsedMs: number;
  errorMessage: string | null;
  liveText: string;
  shortcutLabel: string;
  inputTarget: VoiceInputTarget;
  hasGlobalShortcut: boolean;
}

interface VoiceGlobalShortcutStatusPayload {
  registered: boolean;
  shortcut: string | null;
  errorMessage: string | null;
}

interface VoiceGlobalShortcutTriggerPayload {
  action: "press" | "release";
}

function VoiceWorkerWindow() {
  const asrApiKey = useAppStore((s) => s.asrApiKey);
  const asrAuthMode = useAppStore((s) => s.asrAuthMode);
  const asrModel = useAppStore((s) => s.asrModel);
  const asrRegion = useAppStore((s) => s.asrRegion);
  const voicePolishEnabled = useAppStore((s) => s.voicePolishEnabled);
  const voicePolishModel = useAppStore((s) => s.voicePolishModel);
  const voicePolishProvider = useAppStore((s) => s.voicePolishProvider);
  const voicePolishApiKey = useAppStore((s) => s.voicePolishApiKey);
  const voicePolishAuthMode = useAppStore((s) => s.voicePolishAuthMode);
  const voicePolishRegion = useAppStore((s) => s.voicePolishRegion);
  const voicePolishStyle = useAppStore((s) => s.voicePolishStyle);
  const voiceShortcut = useAppStore((s) => s.voiceShortcut);
  const voiceInputTarget = useAppStore((s) => s.voiceInputTarget);
  const [config, setConfig] = useState<VoiceWorkerConfigPayload>({
    apiKey: asrApiKey,
    authMode: asrAuthMode,
    model: asrModel,
    region: asrRegion,
    polishEnabled: voicePolishEnabled,
    polishModel: voicePolishModel,
    polishProvider: voicePolishProvider,
    polishApiKey: voicePolishApiKey,
    polishAuthMode: voicePolishAuthMode,
    polishRegion: voicePolishRegion,
    polishStyle: voicePolishStyle,
    shortcut: voiceShortcut,
    inputTarget: voiceInputTarget,
  });
  const [hasGlobalShortcut, setHasGlobalShortcut] = useState(false);

  const voice = useVoiceRecognition({
    apiKey: config.apiKey,
    authMode: config.authMode,
    model: config.model,
    region: config.region,
    polishEnabled: config.polishEnabled,
    polishConfig: {
      provider: config.polishProvider,
      model: config.polishModel,
      apiKey: config.polishApiKey,
      authMode: config.polishAuthMode,
      region: config.polishRegion,
      style: config.polishStyle,
    },
    onResult: (text) => {
      if (config.inputTarget === "system") {
        void sendTextToFocusedWindow(text).catch((err) => {
          console.error("voice worker system input failed:", err);
          void emit("voice-worker-error", {
            code: "system_input_failed",
            message: err instanceof Error && err.message ? err.message : "System voice input failed.",
          });
        });
        return;
      }

      emit("voice-worker-result", { text }).catch((err) => {
        console.error("voice worker system input failed:", err);
        void emit("voice-worker-error", {
          code: "system_input_failed",
          message:
            err instanceof Error && err.message
              ? err.message
              : i18n.t("settings.voice.systemInputFailed", {
                  defaultValue: "系统级语音输入失败，请确认目标输入框当前处于激活状态",
                }),
        });
      });
    },
    onError: (err) => {
      if (err.code === "empty_audio") {
        return;
      }
      void emit("voice-worker-error", err);
    },
  });
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const workerState = useMemo<VoiceWorkerStatePayload>(
    () => ({
      phase: voice.phase,
      level: voice.level,
      elapsedMs: voice.elapsedMs,
      errorMessage: voice.errorMessage,
      liveText: voice.liveText,
      shortcutLabel: config.shortcut,
      inputTarget: config.inputTarget,
      hasGlobalShortcut,
    }),
    [
      config.shortcut,
      hasGlobalShortcut,
      voice.elapsedMs,
      voice.errorMessage,
      voice.liveText,
      voice.level,
      voice.phase,
    ],
  );

  useEffect(() => {
    const nextConfig: VoiceWorkerConfigPayload = {
      apiKey: asrApiKey,
      authMode: asrAuthMode,
      model: asrModel,
      region: asrRegion,
      polishEnabled: voicePolishEnabled,
      polishModel: voicePolishModel,
      polishProvider: voicePolishProvider,
      polishApiKey: voicePolishApiKey,
      polishAuthMode: voicePolishAuthMode,
      polishRegion: voicePolishRegion,
      polishStyle: voicePolishStyle,
      shortcut: voiceShortcut,
      inputTarget: voiceInputTarget,
    };
    setConfig(nextConfig);
  }, [asrApiKey, asrAuthMode, asrModel, asrRegion, voiceInputTarget, voicePolishEnabled, voicePolishModel, voicePolishProvider, voicePolishApiKey, voicePolishAuthMode, voicePolishRegion, voicePolishStyle, voiceShortcut]);

  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen<VoiceWorkerConfigPayload>("voice-worker-config", (event) => {
      if (!disposed) {
        setConfig((current) => ({ ...current, ...event.payload }));
      }
    });

    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const handleAction = (action?: VoiceWorkerAction) => {
      const currentVoice = voiceRef.current;
      if (action === "press") {
        if (
          currentVoice.phase === "idle" ||
          currentVoice.phase === "error" ||
          currentVoice.phase === "done"
        ) {
          void currentVoice.start();
        }
        return;
      }
      if (action === "release") {
        // stop 内部读取实时 phaseRef，避免 React 尚未重渲染时漏掉释放。
        void currentVoice.stop();
        return;
      }
      if (action === "toggle") {
        if (currentVoice.phase === "recording") {
          void currentVoice.stop();
        } else if (
          currentVoice.phase === "requesting_permission" ||
          currentVoice.phase === "transcribing"
        ) {
          currentVoice.cancel();
        } else if (
          currentVoice.phase === "idle" ||
          currentVoice.phase === "error" ||
          currentVoice.phase === "done"
        ) {
          void currentVoice.start();
        }
        return;
      }
      if (action === "cancel") {
        currentVoice.cancel();
      }
    };

    const unlistenControlPromise = listen<VoiceWorkerControlPayload>("voice-worker-control", (event) => {
      if (disposed) {
        return;
      }
      handleAction(event.payload?.action);
    });

    const unlistenShortcutPromise = listen<VoiceGlobalShortcutTriggerPayload>(
      "voice-global-shortcut-trigger",
      (event) => {
        if (disposed) {
          return;
        }
        handleAction(event.payload?.action);
      }
    );

    return () => {
      disposed = true;
      void unlistenControlPromise.then((unlisten) => unlisten());
      void unlistenShortcutPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen<VoiceGlobalShortcutStatusPayload>(
      "voice-global-shortcut-state",
      (event) => {
        if (!disposed) {
          setHasGlobalShortcut(event.payload.registered);
        }
      }
    );

    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const overlayState = useMemo(
    () => ({
      phase: workerState.phase,
      level: workerState.level,
      elapsedMs: workerState.elapsedMs,
      errorMessage: workerState.errorMessage,
      liveText: workerState.liveText,
      shortcutLabel: workerState.shortcutLabel,
    }),
    [
      workerState.elapsedMs,
      workerState.errorMessage,
      workerState.liveText,
      workerState.level,
      workerState.phase,
      workerState.shortcutLabel,
    ],
  );
  const overlayStateRef = useRef(overlayState);
  overlayStateRef.current = overlayState;

  useEffect(() => {
    void emit("voice-worker-state", workerState);
    void emit("voice-overlay-state", overlayState);
  }, [overlayState, workerState]);

  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen("voice-overlay-ready", () => {
      if (!disposed) {
        void emit("voice-overlay-state", overlayStateRef.current);
      }
    });

    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const isOverlayActive =
      workerState.phase !== "idle" &&
      workerState.phase !== "done";

    if (!isOverlayActive) {
      hideVoiceOverlayWindow().catch(() => undefined);
      return;
    }

    let disposed = false;
    const showOverlay = async () => {
      try {
        await ensureVoiceOverlayWindow();
        // 显示窗口也可能迟到；取消后不能由旧请求重新显示浮层。
        const latestState = overlayStateRef.current;
        if (latestState.phase === "idle" || latestState.phase === "done") {
          await hideVoiceOverlayWindow();
          return;
        }
        if (!disposed) await emit("voice-overlay-state", latestState);
      } catch (error) {
        if (disposed) return;
        console.error("voice worker failed to ensure overlay window:", error);
        void emit("voice-worker-error", {
          code: "overlay_show_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    void showOverlay();

    // 周期性重新声明窗口可见性，恢复平台层丢失的 show 请求。
    const reassertTimer = setInterval(() => {
      void showOverlay();
    }, VOICE_OVERLAY_REASSERT_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(reassertTimer);
    };
  }, [workerState.phase]);

  return null;
}

export default VoiceWorkerWindow;
