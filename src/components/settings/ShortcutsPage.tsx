import { useEffect } from "react";
import { Button, message } from "antd";
import { useTranslation } from "react-i18next";
import { SHORTCUTS, type ShortcutAction } from "@/constants/shortcuts";
import { useAppStore, DEFAULT_VOICE_SHORTCUT } from "@/store";
import { useShortcutStore } from "@/store/slices/shortcutSlice";
import { captureAppShortcut, createDoubleShiftMatcher, findShortcutConflict, getAppShortcut, isValidAppShortcut } from "@/lib/appShortcuts";
import { formatShortcutDisplay } from "@/lib/shortcut";
import { ShortcutHint } from "@/components/ui/ShortcutHint";
import { SettingsPageHeader } from "./SettingsPageHeader";

export function ShortcutsPage() {
  const { t } = useTranslation();
  const { overrides, recordingAction, preparing, setShortcut, setDefaultShortcut, setRecordingAction } = useShortcutStore();
  const voiceShortcut = useAppStore((s) => s.voiceShortcut);
  const setVoiceShortcut = useAppStore((s) => s.setVoiceShortcut);

  function applyShortcut(action: ShortcutAction, keys: string): boolean {
    const conflict = findShortcutConflict(overrides, action, keys, voiceShortcut);
    if (conflict) {
      message.warning(t("settings.shortcuts.conflict", { action: t(`settings.shortcuts.${conflict}`) }));
      return false;
    }
    if (action === "voiceInput") setVoiceShortcut(keys);
    else setShortcut(action, keys);
    void setRecordingAction(null);
    return true;
  }

  function restoreShortcut(action: ShortcutAction, keys: string) {
    const conflict = findShortcutConflict(overrides, action, keys, voiceShortcut);
    if (conflict) {
      message.warning(t("settings.shortcuts.conflict", { action: t(`settings.shortcuts.${conflict}`) }));
      return;
    }
    if (action === "voiceInput") setVoiceShortcut(DEFAULT_VOICE_SHORTCUT);
    else setDefaultShortcut(action);
    message.success(t("settings.shortcuts.resetSuccess"));
  }

  useEffect(() => {
    if (!recordingAction) return;
    const doubleShift = createDoubleShiftMatcher();
    const handleKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "keydown" && event.key === "Escape") {
        void setRecordingAction(null);
        return;
      }
      if (preparing || event.isComposing) return;
      if (doubleShift(event, Date.now())) {
        if (recordingAction === "searchEverywhere") applyShortcut(recordingAction, "Double Shift");
        return;
      }
      if (event.type !== "keydown") return;
      const keys = captureAppShortcut(event);
      if (!keys) return;
      if (!isValidAppShortcut(keys)) {
        message.warning(t("settings.shortcuts.invalid"));
        return;
      }
      applyShortcut(recordingAction, keys);
    };
    const cancel = () => { void setRecordingAction(null); };
    window.addEventListener("keydown", handleKey, true);
    window.addEventListener("keyup", handleKey, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", handleKey, true);
      window.removeEventListener("keyup", handleKey, true);
      window.removeEventListener("blur", cancel);
    };
  });

  useEffect(() => () => { void useShortcutStore.getState().setRecordingAction(null); }, []);

  return (
    <>
      <SettingsPageHeader title={t("settings.menu.shortcuts")} actions={
        <Button disabled={recordingAction !== null} onClick={() => {
          setDefaultShortcut();
          setVoiceShortcut(DEFAULT_VOICE_SHORTCUT);
          message.success(t("settings.shortcuts.resetSuccess"));
        }}>{t("settings.shortcuts.resetAll")}</Button>
      } />
      <p className="mb-4 text-sm text-[var(--cs-text-secondary)]">{t("settings.shortcuts.description")}</p>
      <div className="app-shortcuts-list app-glass-card overflow-hidden rounded-xl border border-[var(--cs-border-card)] bg-[var(--cs-bg-card)]">
        {SHORTCUTS.map((item) => {
          const recording = recordingAction === item.id;
          const keys = getAppShortcut(overrides, item.id, voiceShortcut);
          const defaultKeys = item.id === "voiceInput" ? DEFAULT_VOICE_SHORTCUT : item.keys;
          return (
            <div key={item.id} className="app-shortcuts-row flex flex-wrap items-center justify-between gap-3 border-b border-[var(--cs-border-card)] px-4 py-3 last:border-b-0">
              <span className="text-sm text-[var(--cs-text-primary)]">{t(item.i18nKey)}</span>
              <div className="flex flex-wrap items-center gap-2">
                <Button type={recording ? "primary" : "default"}
                  className="app-shortcut-recorder min-w-[180px]"
                  aria-label={t("settings.shortcuts.edit", { action: t(item.i18nKey) })}
                  aria-pressed={recording}
                  disabled={recordingAction !== null && !recording}
                  onClick={() => { void setRecordingAction(recording ? null : item.id).catch(() => {
                    message.error(t("settings.voiceRecognition.shortcutRecordFailed"));
                  }); }}>
                  {recording ? t(preparing ? "settings.shortcuts.preparing" : "settings.shortcuts.recording")
                    : keys ? <ShortcutHint keys={keys === "Double Shift" ? t("settings.shortcuts.doubleShift") : formatShortcutDisplay(keys)} />
                      : t("settings.shortcuts.unassigned")}
                </Button>
                <Button size="small" disabled={recordingAction !== null || !keys}
                  aria-label={t("settings.shortcuts.clearAction", { action: t(item.i18nKey) })}
                  onClick={() => applyShortcut(item.id, "")}>{t("settings.shortcuts.clear")}</Button>
                <Button size="small" disabled={recordingAction !== null || formatShortcutDisplay(keys) === formatShortcutDisplay(defaultKeys)}
                  aria-label={t("settings.shortcuts.resetAction", { action: t(item.i18nKey) })}
                  onClick={() => restoreShortcut(item.id, defaultKeys)}>{t("settings.shortcuts.reset")}</Button>
              </div>
            </div>
          );
        })}
      </div>
      <p role="status" className="mt-3 text-xs text-[var(--cs-text-secondary)]">{t("settings.shortcuts.recordHint")}</p>
    </>
  );
}
