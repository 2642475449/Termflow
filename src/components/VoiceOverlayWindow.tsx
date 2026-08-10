import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { VoiceStatusCapsule } from "@/components/VoiceButton";
import type { AsrPhase } from "@/hooks/useVoiceRecognition";

interface VoiceOverlayStatePayload {
  phase: AsrPhase;
  level: number;
  elapsedMs: number;
  errorMessage: string | null;
  shortcutLabel: string;
}

const INITIAL_STATE: VoiceOverlayStatePayload = {
  phase: "idle",
  level: 0,
  elapsedMs: 0,
  errorMessage: null,
  shortcutLabel: "Ctrl+Shift+V",
};

function VoiceOverlayWindow() {
  const [voiceState, setVoiceState] = useState<VoiceOverlayStatePayload>(INITIAL_STATE);

  useEffect(() => {
    const root = document.getElementById("root");
    const htmlStyle = document.documentElement.style;
    const bodyStyle = document.body.style;
    const rootStyle = root?.style;
    const previousHtml = {
      background: htmlStyle.background,
      backgroundColor: htmlStyle.backgroundColor,
      backgroundImage: htmlStyle.backgroundImage,
    };
    const previousBody = {
      background: bodyStyle.background,
      backgroundColor: bodyStyle.backgroundColor,
      backgroundImage: bodyStyle.backgroundImage,
      pointerEvents: bodyStyle.pointerEvents,
      overflow: bodyStyle.overflow,
    };
    const previousRoot = rootStyle
      ? {
          background: rootStyle.background,
          backgroundColor: rootStyle.backgroundColor,
          backgroundImage: rootStyle.backgroundImage,
        }
      : null;

    htmlStyle.background = "transparent";
    htmlStyle.backgroundColor = "transparent";
    htmlStyle.backgroundImage = "none";
    bodyStyle.background = "transparent";
    bodyStyle.backgroundColor = "transparent";
    bodyStyle.backgroundImage = "none";
    bodyStyle.pointerEvents = "none";
    bodyStyle.overflow = "hidden";
    if (rootStyle) {
      rootStyle.background = "transparent";
      rootStyle.backgroundColor = "transparent";
      rootStyle.backgroundImage = "none";
    }

    return () => {
      htmlStyle.background = previousHtml.background;
      htmlStyle.backgroundColor = previousHtml.backgroundColor;
      htmlStyle.backgroundImage = previousHtml.backgroundImage;
      bodyStyle.background = previousBody.background;
      bodyStyle.backgroundColor = previousBody.backgroundColor;
      bodyStyle.backgroundImage = previousBody.backgroundImage;
      bodyStyle.pointerEvents = previousBody.pointerEvents;
      bodyStyle.overflow = previousBody.overflow;
      if (rootStyle && previousRoot) {
        rootStyle.background = previousRoot.background;
        rootStyle.backgroundColor = previousRoot.backgroundColor;
        rootStyle.backgroundImage = previousRoot.backgroundImage;
      }
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const unlistenPromise = listen<VoiceOverlayStatePayload>("voice-overlay-state", (event) => {
      if (!disposed) {
        setVoiceState(event.payload);
      }
    });

    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        pointerEvents: "none",
      }}
    >
      <VoiceStatusCapsule
        phase={voiceState.phase}
        level={voiceState.level}
        elapsedMs={voiceState.elapsedMs}
        errorMessage={voiceState.errorMessage}
        shortcutLabel={voiceState.shortcutLabel}
        onStart={() => {}}
        onStop={() => {}}
        interactive={false}
        showText={voiceState.phase === "error"}
        wrapperStyle={{
          pointerEvents: "none",
          // The card variables are white in light themes and dark in dark themes.
          // Keeping the capsule opaque avoids the gray cast transparent surfaces pick up
          // from the window behind it.
          background: "var(--cs-bg-card-solid, var(--cs-bg-card, #ffffff))",
          border:
            "1px solid var(--cs-border-card, var(--cs-border, rgba(15, 23, 42, 0.12)))",
          backdropFilter: "none",
          WebkitBackdropFilter: "none",
          boxShadow: "none",
        }}
      />
    </div>
  );
}

export default VoiceOverlayWindow;
