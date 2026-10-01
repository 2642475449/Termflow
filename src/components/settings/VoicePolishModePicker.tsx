import { Select } from "antd";
import { useTranslation } from "react-i18next";
import { VOICE_POLISH_STYLES, type VoicePolishStyle } from "@/lib/voicePolish";
import { diffVoicePolishPreview } from "@/lib/voicePolishPreview";

export function VoicePolishModePicker({ value, onChange }: {
  value: VoicePolishStyle;
  onChange: (mode: VoicePolishStyle) => void;
}) {
  const { t } = useTranslation();
  const prefix = "settings.voiceRecognition";
  const source = t(`${prefix}.polishingPreview.source`);
  const changes = diffVoicePolishPreview(source, t(`${prefix}.polishingPreview.results.${value}`));
  return (
    <div className="app-voice-polish-modes px-4 py-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-[var(--cs-text-primary)]">{t(`${prefix}.polishingStyleLabel`)}</h3>
        </div>
        <Select<VoicePolishStyle>
          className="w-full sm:w-80 xl:shrink-0"
          aria-label={t(`${prefix}.polishingStyleLabel`)}
          value={value}
          onChange={onChange}
          showSearch={false}
          options={VOICE_POLISH_STYLES.map((mode) => ({
            value: mode,
            label: t(`${prefix}.polishingStyles.${mode}`),
          }))}
        />
      </div>
      <div className="app-voice-polish-preview mt-3 rounded-lg border border-[var(--cs-border)] bg-[var(--cs-bg-content)] p-3" aria-label={t(`${prefix}.polishingPreview.fixedHint`)}>
        <div className="text-sm leading-6 text-[var(--cs-text-primary)]">
          {changes.map((change, changeIndex) => {
            const content = change.text.split("\n").map((line, lineIndex) => (
              <span key={lineIndex}>{lineIndex > 0 && <><span className="text-xs text-[var(--cs-primary)]" aria-label={t(`${prefix}.polishingPreview.lineBreak`)}>↵</span><br /></>}{line}</span>
            ));
            return change.kind === "deleted"
              ? <del key={changeIndex} className="rounded-sm bg-[var(--cs-danger-hover)] text-[var(--cs-danger)]">{content}</del>
              : change.kind === "added"
                ? <ins key={changeIndex} className="rounded-sm bg-[var(--cs-primary-light)] text-[var(--cs-primary)] no-underline">{content}</ins>
                : <span key={changeIndex}>{content}</span>;
          })}
        </div>
      </div>
    </div>
  );
}
