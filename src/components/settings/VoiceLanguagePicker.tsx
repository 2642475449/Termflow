import { Select } from "antd";
import { useTranslation } from "react-i18next";
import { ASR_LANGUAGES, supportsAsrLanguagePreference } from "@/lib/asrLanguage";
import { useAppStore } from "@/store";
import { VoiceSettingsField } from "./VoiceSettingsLayout";

export function VoiceLanguagePicker() {
  const { t } = useTranslation();
  const model = useAppStore((state) => state.asrModel);
  const language = useAppStore((state) => state.asrLanguage);
  const setLanguage = useAppStore((state) => state.setAsrLanguage);
  const supported = supportsAsrLanguagePreference(model);
  const prefix = "settings.voiceRecognition.language";

  return (
    <div className="app-voice-settings-grid col-span-full items-end">
      <VoiceSettingsField htmlFor="voice-asr-language" label={t(`${prefix}.label`)}>
        <Select id="voice-asr-language" className="w-full" value={supported ? language : "auto"}
          disabled={!supported} onChange={setLanguage} aria-describedby="voice-asr-language-hint"
          options={ASR_LANGUAGES.map((value) => ({ value, label: t(`${prefix}.options.${value}`) }))} />
      </VoiceSettingsField>
      <p id="voice-asr-language-hint" className="m-0 self-end text-xs leading-5 text-[var(--cs-text-secondary)]">
        {t(`${prefix}.${supported ? "hint" : "unsupported"}`)}
      </p>
    </div>
  );
}
