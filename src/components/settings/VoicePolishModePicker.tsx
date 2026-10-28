import { Select } from "antd";
import { useTranslation } from "react-i18next";
import { VOICE_POLISH_STYLES, type VoicePolishStyle } from "@/lib/voicePolish";
import { VoiceSettingsField } from "./VoiceSettingsLayout";

export function VoicePolishModePicker({ value, onChange }: {
  value: VoicePolishStyle;
  onChange: (mode: VoicePolishStyle) => void;
}) {
  const { t } = useTranslation();
  const prefix = "settings.voiceRecognition";
  return (
    <VoiceSettingsField htmlFor="voice-polish-style" label={t(`${prefix}.polishingStyleLabel`)}>
      <Select<VoicePolishStyle>
        id="voice-polish-style"
        className="w-full"
        aria-label={t(`${prefix}.polishingStyleLabel`)}
        value={value}
        onChange={onChange}
        showSearch={false}
        options={VOICE_POLISH_STYLES.map((mode) => ({
          value: mode,
          label: t(`${prefix}.polishingStyles.${mode}`),
        }))}
      />
    </VoiceSettingsField>
  );
}
