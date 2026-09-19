import { useCallback, useEffect } from "react";
import { Button, Checkbox, Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import { onBackgroundSettingsChanged, onWorkspaceCloseRequested } from "@/lib/api";
import {
  chooseWorkspaceClose, refreshBackgroundSettings, requestWorkspaceClose, useBackgroundStore,
} from "@/store/slices/background";

export function BackgroundCloseController() {
  const { t } = useTranslation();
  const { promptOpen, busy, remember, setRemember, setPromptOpen } = useBackgroundStore();

  const reportError = useCallback((error: unknown) => {
    message.error(error instanceof Error && error.message === "application-update-in-progress"
      ? t("updater.keepOpenDuringDownload") : t("background.actionFailed", { error: String(error) }));
  }, [t]);

  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    function register(cleanup: () => void) {
      if (disposed) cleanup();
      else cleanups.push(cleanup);
    }
    void onWorkspaceCloseRequested((exit) => {
      void requestWorkspaceClose(exit).catch(reportError);
    }).then(register).catch(reportError);
    void onBackgroundSettingsChanged((settings) => {
      useBackgroundStore.getState().setSettings(settings);
    }).then(register).catch(reportError);
    void refreshBackgroundSettings().catch(reportError);
    return () => { disposed = true; cleanups.forEach((cleanup) => cleanup()); };
  }, [reportError]);

  return (
    <Modal open={promptOpen} title={t("background.closeTitle")} onCancel={() => setPromptOpen(false)}
      closable={!busy} maskClosable={!busy} keyboard={!busy}
      footer={[
        <Button key="cancel" disabled={busy} onClick={() => setPromptOpen(false)}>{t("common.cancel")}</Button>,
        <Button key="close" disabled={busy} onClick={() => void chooseWorkspaceClose(false).catch(reportError)}>{t("background.closeNow")}</Button>,
        <Button key="background" type="primary" loading={busy} onClick={() => void chooseWorkspaceClose(true).catch(reportError)}>{t("background.keepRunning")}</Button>,
      ]}>
      <p className="mb-3">{t("background.closeDescription")}</p>
      <p className="mb-4 text-xs text-[var(--cs-text-secondary)]">{t("background.sleepHint")}</p>
      <Checkbox checked={remember} disabled={busy} onChange={(event) => setRemember(event.target.checked)}>{t("background.remember")}</Checkbox>
    </Modal>
  );
}
