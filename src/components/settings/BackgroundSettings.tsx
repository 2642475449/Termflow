import { Switch, message } from "antd";
import { useTranslation } from "react-i18next";
import { saveBackgroundSettings, useBackgroundStore } from "@/store/slices/background";
import { SettingRow } from "./SettingRow";

export function BackgroundSettings() {
  const { t } = useTranslation();
  const { settings, ready, busy } = useBackgroundStore();
  return <>
    {(["runInBackground", "askBeforeClose"] as const).map((key) => (
      <SettingRow key={key} label={t(`background.${key}`)} desc={t(`background.${key}Description`)}>
        <Switch checked={settings[key]} disabled={!ready || busy} loading={busy}
          aria-label={t(`background.${key}`)} onChange={(checked) => {
            const next = { ...settings, [key]: checked };
            // 主动指定关闭行为后立即生效；仍可单独重新打开询问。
            if (key === "runInBackground") next.askBeforeClose = false;
            void saveBackgroundSettings(next).catch((error: unknown) => message.error(t("background.actionFailed", { error: String(error) })));
          }} />
      </SettingRow>
    ))}
  </>;
}
