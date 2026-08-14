import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dropdown, Tooltip } from "antd";
import {
  AudioOutlined,
  AudioMutedOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  EyeInvisibleOutlined,
  LoadingOutlined,
} from "@ant-design/icons";
import type { AsrPhase } from "@/hooks/useVoiceRecognition";

export interface VoiceStatusCapsuleProps {
  phase: AsrPhase;
  level: number;
  elapsedMs: number;
  errorMessage?: string | null;
  shortcutLabel: string;
  onStart: () => void;
  onStop: () => void;
  onCancel?: () => void;
  wrapperStyle?: React.CSSProperties;
  interactive?: boolean;
  showText?: boolean;
}

const PHASE_TOOLTIP_KEY: Record<AsrPhase, string> = {
  idle: "settings.voice.idleTooltip",
  requesting_permission: "settings.voice.requestingPermission",
  recording: "settings.voice.recordingTooltip",
  transcribing: "settings.voice.transcribing",
  done: "settings.voice.doneTooltip",
  error: "settings.voice.errorTooltip",
};

const phaseColor = (phase: AsrPhase): { fg: string; bg: string; border: string } => {
  if (phase === "recording") {
    return { fg: "var(--cs-error)", bg: "color-mix(in srgb, var(--cs-error) 12%, transparent)", border: "color-mix(in srgb, var(--cs-error) 45%, transparent)" };
  }
  if (phase === "error") {
    return { fg: "var(--cs-error)", bg: "color-mix(in srgb, var(--cs-error) 10%, transparent)", border: "color-mix(in srgb, var(--cs-error) 40%, transparent)" };
  }
  if (phase === "done") {
    return { fg: "var(--cs-success)", bg: "color-mix(in srgb, var(--cs-success) 10%, transparent)", border: "color-mix(in srgb, var(--cs-success) 40%, transparent)" };
  }
  if (phase === "transcribing" || phase === "requesting_permission") {
    return { fg: "var(--cs-primary, #1677ff)", bg: "rgba(22,119,255,0.08)", border: "rgba(22,119,255,0.30)" };
  }
  return {
    fg: "var(--cs-text-primary, #e8e6f0)",
    bg: "var(--cs-bg-card, rgba(20,20,30,0.85))",
    border: "var(--cs-border-card, rgba(255,255,255,0.10))",
  };
};

const WAVEFORM_PROFILE = [0.42, 0.62, 0.8, 1, 0.7, 0.9, 0.74, 1, 0.8, 0.62, 0.42];

function clampLevel(level: number): number {
  return Math.min(1, Math.max(0, level * 2.25));
}

function useSmoothedAudioLevel(level: number, active: boolean, reducedMotion: boolean): number {
  const targetRef = useRef(clampLevel(level));
  const [smoothedLevel, setSmoothedLevel] = useState(targetRef.current);

  useEffect(() => {
    targetRef.current = clampLevel(level);
  }, [level]);

  useEffect(() => {
    if (!active) {
      setSmoothedLevel(0);
      return;
    }

    if (reducedMotion) {
      setSmoothedLevel(targetRef.current);
      return;
    }

    let current = targetRef.current;
    let frameId = 0;
    const tick = () => {
      const target = targetRef.current;
      current += (target - current) * 0.18;
      if (Math.abs(target - current) < 0.003) current = target;
      setSmoothedLevel((previous) =>
        Math.abs(previous - current) < 0.002 ? previous : current,
      );
      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [active, reducedMotion]);

  return smoothedLevel;
}

function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  return reducedMotion;
}

const Equalizer: React.FC<{
  level: number;
  phase: AsrPhase;
  color: string;
  expanded?: boolean;
  reducedMotion?: boolean;
}> = ({
  level,
  phase,
  color,
  expanded = false,
  reducedMotion = false,
}) => {
  const smoothedLevel = useSmoothedAudioLevel(level, phase === "recording", reducedMotion);
  if (phase !== "recording") {
    return <div style={{ width: expanded ? 44 : 18 }} />;
  }
  const profile = expanded ? WAVEFORM_PROFILE : [0.58, 1, 0.58];
  const baseHeight = expanded ? 3 : 4;
  const amplitude = expanded ? 24 : 14;
  const barWidth = expanded ? 2 : 3;
  const gap = expanded ? 2 : 3;
  const heights = profile.map((weight) =>
    baseHeight + (expanded ? 0.16 : 0.2) * amplitude + smoothedLevel * weight * amplitude,
  );
  return (
    <div
      aria-hidden
      style={{
        display: "flex",
        alignItems: "center",
        gap,
        height: expanded ? 26 : 18,
        width: expanded ? 44 : 18,
        justifyContent: "center",
      }}
    >
      {heights.map((h, i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            width: barWidth,
            height: `${Math.max(3, h)}px`,
            background: color,
            borderRadius: expanded ? 999 : 1.5,
            transition: reducedMotion ? "none" : "height 150ms cubic-bezier(0.22, 1, 0.36, 1)",
            opacity: expanded ? 0.95 : 0.9,
          }}
        />
      ))}
    </div>
  );
};

const CompactStatusLabel: React.FC<{ phase: AsrPhase }> = ({ phase }) => {
  if (phase !== "transcribing") {
    return null;
  }

  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.6,
        color: "var(--cs-text-primary, #e8e6f0)",
        whiteSpace: "nowrap",
      }}
    >
      识别中
    </span>
  );
};

const TimeBadge: React.FC<{ elapsedMs: number; phase: AsrPhase }> = ({
  elapsedMs,
  phase,
}) => {
  if (phase !== "recording") return null;
  const seconds = Math.floor(elapsedMs / 1000);
  const mm = Math.floor(seconds / 60).toString().padStart(2, "0");
  const ss = (seconds % 60).toString().padStart(2, "0");
  return (
    <span
      style={{
        fontSize: 12,
        fontVariantNumeric: "tabular-nums",
        fontWeight: 600,
        color: "var(--cs-error)",
        letterSpacing: 0.3,
      }}
    >
      {mm}:{ss}
    </span>
  );
};

const STATUS_TEXT_DEFAULTS: Record<AsrPhase, string> = {
  idle: "点击或按住快捷键开始语音输入",
  requesting_permission: "请求麦克风权限...",
  recording: "正在录音，松开快捷键或点击结束",
  transcribing: "转录中...",
  done: "识别完成",
  error: "发生错误，请重试",
};

function withShortcutLabel(text: string, shortcutLabel: string): string {
  const trimmedShortcut = shortcutLabel.trim();
  return trimmedShortcut ? `${text} (${trimmedShortcut})` : text;
}

const StatusText: React.FC<{ phase: AsrPhase; errorMessage?: string | null }> = ({
  phase,
  errorMessage,
}) => {
  const { t } = useTranslation();
  let text = t("settings.voice.idleTooltip", { defaultValue: STATUS_TEXT_DEFAULTS.idle });
  if (phase === "recording") {
    text = t("settings.voice.recordingTooltip", { defaultValue: STATUS_TEXT_DEFAULTS.recording });
  } else if (phase === "transcribing") {
    text = t("settings.voice.transcribing", { defaultValue: STATUS_TEXT_DEFAULTS.transcribing });
  } else if (phase === "done") {
    text = t("settings.voice.doneTooltip", { defaultValue: STATUS_TEXT_DEFAULTS.done });
  } else if (phase === "error") {
    text = errorMessage?.trim()
      ? errorMessage
      : t("settings.voice.errorTooltip", { defaultValue: STATUS_TEXT_DEFAULTS.error });
  } else if (phase === "requesting_permission") {
    text = t("settings.voice.requestingPermission", {
      defaultValue: STATUS_TEXT_DEFAULTS.requesting_permission,
    });
  }
  return (
    <span
      style={{
        fontSize: 12,
        fontWeight: 500,
        color: "var(--cs-text-primary, #e8e6f0)",
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
};

const PhaseIcon: React.FC<{ phase: AsrPhase; color: string }> = ({ phase, color }) => {
  const iconStyle: React.CSSProperties = {
    fontSize: 18,
    color,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  };
  if (phase === "requesting_permission" || phase === "transcribing") {
    return <LoadingOutlined spin style={iconStyle} />;
  }
  if (phase === "recording") return <AudioMutedOutlined style={iconStyle} />;
  if (phase === "done") return <CheckCircleFilled style={iconStyle} />;
  if (phase === "error") return <CloseCircleFilled style={iconStyle} />;
  return <AudioOutlined style={iconStyle} />;
};

export const VoiceStatusCapsule: React.FC<VoiceStatusCapsuleProps> = ({
  phase,
  level,
  elapsedMs,
  errorMessage,
  shortcutLabel,
  onStart,
  onStop,
  wrapperStyle,
  interactive = true,
  showText = true,
}) => {
  const isRecording = phase === "recording";
  const isBusy = phase === "transcribing" || phase === "requesting_permission";
  const isActive = phase !== "idle";
  const prefersReducedMotion = usePrefersReducedMotion();
  const { fg, bg, border } = phaseColor(phase);
  const { t } = useTranslation();
  const tooltipText = phase === "error" && errorMessage?.trim()
    ? withShortcutLabel(errorMessage, shortcutLabel)
    : withShortcutLabel(t(PHASE_TOOLTIP_KEY[phase], {
        defaultValue: STATUS_TEXT_DEFAULTS[phase],
      }), shortcutLabel);

  const handleClick = () => {
    if (!interactive) return;
    if (isBusy) return;
    if (isRecording) void onStop();
    else void onStart();
  };

  if (!isActive) {
    return null;
  }

  const isError = phase === "error";
  const showRecordingMeta = phase === "recording";
  const showCompactStatusLabel = !showText && phase === "transcribing";
  const shouldShowDivider = showText && showRecordingMeta;
  const hideRecordingIcon = !showText && phase === "recording";
  const compactMinWidth = !showText
    ? phase === "recording"
      ? 116
      : phase === "transcribing"
        ? 88
        : 48
    : undefined;

  return (
    <>
      <style>{`
        @keyframes termflow-voice-capsule-enter {
          from { opacity: 0; transform: scale(0.97); }
          to   { opacity: 1; transform: scale(1); }
        }
        @keyframes termflow-voice-shake {
          0%, 100% { transform: translateX(0); }
          25%      { transform: translateX(-3px); }
          75%      { transform: translateX(3px); }
        }
      `}</style>
      <div
        style={{
          position: "relative",
          display: "inline-flex",
        }}
      >
        <div
          role="status"
          aria-live="polite"
          onClick={handleClick}
          title={interactive ? tooltipText : undefined}
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            gap: showText ? 10 : 8,
            padding: showText ? "8px 16px 8px 12px" : "9px 13px",
            minWidth: compactMinWidth,
            justifyContent: !showText ? "center" : undefined,
            borderRadius: 999,
            background: bg,
            border: `1px solid ${border}`,
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            boxShadow: "none",
            color: fg,
            cursor: !interactive ? "default" : isBusy ? "wait" : "pointer",
            userSelect: "none",
            willChange: "transform, opacity",
            transition: prefersReducedMotion
              ? "none"
              : "min-width 220ms cubic-bezier(0.22, 1, 0.36, 1), padding 180ms cubic-bezier(0.22, 1, 0.36, 1), gap 180ms cubic-bezier(0.22, 1, 0.36, 1), background-color 180ms ease, border-color 180ms ease, color 180ms ease",
            animation: prefersReducedMotion
              ? "none"
              : isError
                ? "termflow-voice-shake 0.35s ease-in-out"
                : "termflow-voice-capsule-enter 0.18s cubic-bezier(0.22, 1, 0.36, 1)",
            ...wrapperStyle,
          }}
        >
          {hideRecordingIcon ? null : <PhaseIcon phase={phase} color={fg} />}
          {showText ? <StatusText phase={phase} errorMessage={errorMessage} /> : null}
          {showCompactStatusLabel ? <CompactStatusLabel phase={phase} /> : null}
          {shouldShowDivider ? (
            <div
              style={{
                width: 1,
                height: showText ? 14 : 16,
                background: border,
                opacity: showText ? 1 : 0.9,
              }}
            />
          ) : null}
          {showRecordingMeta ? (
            <>
              <Equalizer
                level={level}
                phase={phase}
                color={fg}
                expanded={!showText}
                reducedMotion={prefersReducedMotion}
              />
              <TimeBadge elapsedMs={elapsedMs} phase={phase} />
            </>
          ) : null}
        </div>
      </div>
    </>
  );
};

export const VoiceButton: React.FC<VoiceStatusCapsuleProps> = (props) => {
  if (props.phase === "idle") {
    return <VoiceStatusCapsule {...props} />;
  }

  return (
    <div
      style={{
        position: "fixed",
        left: "50%",
        bottom: 32,
        transform: "translateX(-50%)",
        zIndex: 1000,
      }}
    >
      <VoiceStatusCapsule {...props} />
    </div>
  );
};

// Companion: small floating trigger button (always visible) — click to start
// voice input when no recording is in progress. Optional complement to the
// recording-time capsule, useful when the user is away from a terminal tab.
export const VoiceTrigger: React.FC<{
  onClick: () => void;
  onHide: () => void;
  shortcutLabel: string;
  visible: boolean;
  phase: AsrPhase;
}> = ({ onClick, onHide, shortcutLabel, visible, phase }) => {
  const { t } = useTranslation();
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  if (!visible) return null;
  const isRecording = phase === "recording";
  const isBusy = phase === "requesting_permission" || phase === "transcribing";
  const tooltip = isRecording
    ? withShortcutLabel(t("settings.voice.recordingTooltip", {
        defaultValue: "正在录音，松开快捷键或点击结束",
      }), shortcutLabel)
    : isBusy
      ? withShortcutLabel(t(PHASE_TOOLTIP_KEY[phase], {
          defaultValue: STATUS_TEXT_DEFAULTS[phase],
        }), shortcutLabel)
      : withShortcutLabel(t("settings.voice.idleTooltip", { defaultValue: "点击或按住快捷键开始语音输入" }), shortcutLabel);

  const icon = isBusy ? (
    <LoadingOutlined spin />
  ) : isRecording ? (
    <AudioMutedOutlined />
  ) : (
    <AudioOutlined />
  );

  return (
    <Dropdown
      menu={{
        items: [
          {
            key: "hide-voice-trigger",
            icon: <EyeInvisibleOutlined />,
            label: t("settings.voiceRecognition.hideTrigger", {
              defaultValue: "隐藏语音输入",
            }),
          },
        ],
        onClick: ({ key }) => {
          if (key === "hide-voice-trigger") onHide();
        },
      }}
      trigger={["contextMenu"]}
      onOpenChange={setContextMenuOpen}
    >
      <Tooltip title={tooltip} placement="left" open={contextMenuOpen ? false : undefined}>
      <button
        type="button"
        aria-label={tooltip}
        onClick={onClick}
        disabled={isBusy}
        style={{
          position: "absolute",
          right: 14,
          bottom: 14,
          zIndex: 30,
          width: 40,
          height: 40,
          borderRadius: 20,
          background: isRecording
            ? "rgba(248,113,113,0.12)"
            : "var(--cs-bg-card, rgba(20,20,30,0.85))",
          border: isRecording
            ? "1px solid rgba(248,113,113,0.45)"
            : "1px solid var(--cs-border-card, rgba(255,255,255,0.10))",
          color: isRecording ? "var(--cs-error)" : "var(--cs-text-primary, #e8e6f0)",
          boxShadow: isRecording
            ? "0 4px 20px rgba(248,113,113,0.30), 0 2px 8px rgba(0,0,0,0.25)"
            : "0 2px 10px rgba(0,0,0,0.25)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: isBusy ? "wait" : "pointer",
          fontSize: 16,
          opacity: isBusy ? 0.8 : 1,
        }}
      >
        {icon}
      </button>
      </Tooltip>
    </Dropdown>
  );
};
