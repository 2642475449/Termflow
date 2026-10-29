import { useEffect } from "react";
import { Button, Tag } from "antd";
import { useTranslation } from "react-i18next";
import { useAgentHookHealthStore } from "@/store/slices/agentHookHealth";
import { SettingsSection } from "./SettingsSection";

export function CodexHookStatus() {
  const { t } = useTranslation();
  const health = useAgentHookHealthStore();
  useEffect(() => { void useAgentHookHealthStore.getState().setCheck(); }, []);
  return (
    <SettingsSection className="app-codex-hook-status" title={t("settings.hooks.health.title")} actions={<>
        <Tag color={health.status === "observed" ? "success" : health.status === "error" ? "error" : "default"}>
          {t(`settings.hooks.health.${health.status}`)}
        </Tag>
        <Button size="small" loading={health.checking} onClick={() => void health.setCheck()}>{t("settings.hooks.health.check")}</Button>
      </>}>
      <p className="m-0 text-xs leading-5 text-[var(--cs-text-secondary)]">
        {t(`settings.hooks.health.${health.status}Hint`)}
      </p>
      {health.configPath && <code className="block break-all text-xs text-[var(--cs-text-tertiary)]">{health.configPath}</code>}
      {health.error && <p className="m-0 break-words text-xs text-[var(--cs-danger)]">{health.error}</p>}
    </SettingsSection>
  );
}
