import { useEffect, useMemo, useState } from "react";
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

interface VoiceWorkerConfigPayload {
  apiKey: string;
  authMode: MimoAuthMode;
  model: string;
  region?: "beijing" | "singapore" | "us";
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
  const voiceShortcut = useAppStore((s) => s.voiceShortcut);
  const voiceInputTarget = useAppStore((s) => s.voiceInputTarget);
  const [config, setConfig] = useState<VoiceWorkerConfigPayload>({
    apiKey: asrApiKey,
    authMode: asrAuthMode,
    model: asrModel,
    region: asrRegion,
    shortcut: voiceShortcut,
    inputTarget: voiceInputTarget,
  });
  const [hasGlobalShortcut, setHasGlobalShortcut] = useState(false);

  const voice = useVoiceRecognition({
    apiKey: config.apiKey,
    authMode: config.authMode,
    model: config.model,
    region: config.region,
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
      void emit("voice-worker-error", err);
    },
  });

  const workerState = useMemo<VoiceWorkerStatePayload>(
    () => ({
      phase: voice.phase,
      level: voice.level,
      elapsedMs: voice.elapsedMs,
      errorMessage: voice.errorMessage,
      shortcutLabel: config.shortcut,
      inputTarget: config.inputTarget,
      hasGlobalShortcut,
    }),
    [
      config.shortcut,
      hasGlobalShortcut,
      voice.elapsedMs,
      voice.errorMessage,
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
      shortcut: voiceShortcut,
      inputTarget: voiceInputTarget,
    };
    setConfig(nextConfig);
  }, [asrApiKey, asrAuthMode, asrModel, asrRegion, voiceInputTarget, voiceShortcut]);

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
      if (action === "press") {
        if (voice.phase === "idle" || voice.phase === "error" || voice.phase === "done") {
          void voice.start();
        }
        return;
      }
      if (action === "release") {
        if (voice.phase === "recording") {
          void voice.stop();
        }
        return;
      }
      if (action === "toggle") {
        if (voice.phase === "recording") {
          void voice.stop();
        } else if (voice.phase === "idle" || voice.phase === "error" || voice.phase === "done") {
          void voice.start();
        }
        return;
      }
      if (action === "cancel") {
        voice.cancel();
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
  }, [voice]);

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

  useEffect(() => {
    void emit("voice-worker-state", workerState);
    void emit("voice-overlay-state", {
      phase: workerState.phase,
      level: workerState.level,
      elapsedMs: workerState.elapsedMs,
      errorMessage: workerState.errorMessage,
      shortcutLabel: workerState.shortcutLabel,
    });
  }, [workerState]);

  useEffect(() => {
    const isOverlayActive =
      workerState.phase !== "idle" &&
      workerState.phase !== "done";

    if (isOverlayActive) {
      ensureVoiceOverlayWindow().catch((error) => {
        console.error("voice worker failed to ensure overlay window:", error);
      });
      return;
    }

    hideVoiceOverlayWindow().catch(() => undefined);
  }, [workerState.phase]);

  return null;
}

export default VoiceWorkerWindow;
