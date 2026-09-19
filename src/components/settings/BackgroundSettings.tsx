import { Switch, message } from "antd";
import { useTranslation } from "react-i18next";
import { saveBackgroundSettings, useBackgroundStore } from "@/store/slices/background";

export function BackgroundSettings() {
  const { t } = useTranslation();
  const { settings, ready, busy } = useBackgroundStore();
  return <div className="flex flex-col gap-4">
    {(["runInBackground", "askBeforeClose"] as const).map((key) => (
      <div key={key} className="flex items-center justify-between gap-4">
        <div><div>{t(`background.${key}`)}</div>
          <p className="mt-1 text-xs text-[var(--cs-text-secondary)]">{t(`background.${key}Description`)}</p>
        </div>
        <Switch checked={settings[key]} disabled={!ready || busy} loading={busy}
          aria-label={t(`background.${key}`)} onChange={(checked) => {
            const next = { ...settings, [key]: checked };
            // 主动指定关闭行为后立即生效；仍可单独重新打开询问。
            if (key === "runInBackground") next.askBeforeClose = false;
            void saveBackgroundSettings(next).catch((error: unknown) => message.error(t("background.actionFailed", { error: String(error) })));
          }} />
      </div>
    ))}
  </div>;
}
