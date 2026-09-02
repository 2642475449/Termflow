import { Alert, Button, Modal, Progress } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import {
  checkForApplicationUpdate,
  downloadPendingApplicationUpdate,
  installPendingApplicationUpdate,
  TERMFLOW_RELEASES_URL,
} from "@/lib/applicationUpdater";
import { openExternalUrl } from "@/lib/api";
import { formatUpdateBytes } from "@/lib/updateProgress";
import { isSessionTurnRunning } from "@/lib/sessions";
import { useAppStore } from "@/store";
import { useApplicationUpdateStore } from "@/store/slices/applicationUpdate";

interface InstallWarningCounts {
  runningTurns: number;
  dirtyTabs: number;
}

export function ApplicationUpdateModal() {
  const { t } = useTranslation();
  const modalOpen = useApplicationUpdateStore((state) => state.modalOpen);
  const update = useApplicationUpdateStore();
  const [confirmCounts, setConfirmCounts] = useState<InstallWarningCounts | null>(null);

  // 弹窗关闭时不渲染也不随进度事件重渲染。
  if (!modalOpen) return null;

  const isBusy = update.phase === "checking" ||
    update.phase === "available" ||
    update.phase === "downloading" ||
    update.phase === "installing";
  const canInstall = update.phase === "ready";
  const canRetry = update.phase === "error";

  const requestInstall = () => {
    // 仅在点击安装时按需读取会话/标签状态，避免常驻订阅导致高频重渲染。
    const appState = useAppStore.getState();
    const runningTurns = appState.sessions.filter(isSessionTurnRunning).length;
    const dirtyTabs = Object.values(appState.tabsById).filter((tab) => tab.dirty).length;
    if (runningTurns > 0 || dirtyTabs > 0) {
      setConfirmCounts({ runningTurns, dirtyTabs });
      return;
    }
    void installPendingApplicationUpdate();
  };

  const handlePrimaryAction = () => {
    if (canInstall) {
      requestInstall();
      return;
    }
    if (!canRetry) return;
    if (update.errorStage === "check") void checkForApplicationUpdate({ manual: true });
    else if (update.errorStage === "download") void downloadPendingApplicationUpdate();
    else void installPendingApplicationUpdate();
  };

  const primaryText = update.phase === "installing"
    ? t("updater.installing")
    : update.phase === "downloading"
      ? update.percent === null
        ? t("updater.downloading")
        : t("updater.downloadingPercent", { percent: update.percent })
      : canRetry
        ? t("updater.retry")
        : t("updater.restartAndInstall");

  return (
    <>
      <Modal
        open={update.modalOpen}
        title={update.availableVersion
          ? t("updater.updateAvailable", { version: update.availableVersion })
          : t("updater.title")}
        okText={primaryText}
        cancelText={t("updater.close")}
        okButtonProps={{ disabled: isBusy }}
        confirmLoading={update.phase === "installing"}
        closable={update.phase !== "installing"}
        maskClosable={update.phase !== "installing"}
        keyboard={update.phase !== "installing"}
        onOk={handlePrimaryAction}
        onCancel={update.closeModal}
      >
        <div className="space-y-3">
          {update.availableVersion ? (
            <p className="m-0 text-sm text-[var(--cs-text-secondary)]">
              {t("updater.versionDescription", {
                currentVersion: update.currentVersion,
                version: update.availableVersion,
              })}
            </p>
          ) : null}

          {update.phase === "checking" || update.phase === "available" ? (
            <Alert type="info" showIcon message={t("updater.preparingDownload")} />
          ) : null}

          {update.phase === "downloading" || update.phase === "ready" || update.phase === "installing" ? (
            <div className="space-y-2 rounded-md border border-[var(--cs-border-subtle)] bg-[var(--cs-bg-tertiary)] p-3">
              <div className="flex items-center justify-between gap-3 text-sm font-medium">
                <span>
                  {update.phase === "downloading"
                    ? t("updater.downloadPhase")
                    : update.phase === "ready"
                      ? t("updater.readyPhase")
                      : t("updater.installPhase")}
                </span>
                {update.percent !== null ? <span>{update.percent}%</span> : null}
              </div>
              <Progress
                percent={update.percent ?? 0}
                status={update.phase === "ready" ? "success" : "active"}
                showInfo={false}
                strokeColor="var(--cs-primary)"
                trailColor="var(--cs-bg-hover)"
              />
              <div className="text-xs text-[var(--cs-text-secondary)]">
                {update.totalBytes === null
                  ? t("updater.downloadedSize", {
                      downloaded: formatUpdateBytes(update.downloadedBytes, i18n.language),
                    })
                  : t("updater.downloadedSizeOfTotal", {
                      downloaded: formatUpdateBytes(update.downloadedBytes, i18n.language),
                      total: formatUpdateBytes(update.totalBytes, i18n.language),
                    })}
              </div>
              <div className="text-xs leading-5 text-[var(--cs-text-tertiary)]">
                {update.phase === "downloading"
                  ? t("updater.backgroundDownloadHint")
                  : update.phase === "ready"
                    ? t("updater.readyHint")
                    : t("updater.installingHint")}
              </div>
            </div>
          ) : null}

          {update.error ? (
            <Alert
              type="error"
              showIcon
              message={update.errorStage === "check"
                ? t("updater.checkFailed")
                : update.errorStage === "download"
                  ? t("updater.downloadFailed")
                  : t("updater.installFailed")}
              description={(
                <div className="space-y-2 text-xs">
                  {update.errorStage === "check" || update.errorStage === "download" ? (
                    <div>{t("updater.githubConnectivityHint")}</div>
                  ) : null}
                  <div className="break-all font-mono">{update.error}</div>
                </div>
              )}
            />
          ) : null}

          {update.errorStage === "check" || update.errorStage === "download" ? (
            <Button onClick={() => void openExternalUrl(TERMFLOW_RELEASES_URL)}>
              {t("updater.manualDownload")}
            </Button>
          ) : null}

          {update.availableVersion ? (
            <div>
              <div className="mb-1 text-sm font-medium">{t("updater.releaseNotes")}</div>
              <div className="max-h-44 overflow-y-auto whitespace-pre-wrap rounded-md bg-[var(--cs-bg-tertiary)] p-3 text-xs leading-5 text-[var(--cs-text-secondary)]">
                {update.releaseNotes || t("updater.noReleaseNotes")}
              </div>
            </div>
          ) : null}
        </div>
      </Modal>

      <Modal
        open={confirmCounts !== null}
        title={t("updater.confirmInstallTitle")}
        okText={t("updater.installAnyway")}
        cancelText={t("common.cancel")}
        onCancel={() => setConfirmCounts(null)}
        onOk={() => {
          setConfirmCounts(null);
          void installPendingApplicationUpdate();
        }}
      >
        <div className="space-y-2">
          <p className="m-0 text-sm text-[var(--cs-text-secondary)]">
            {t("updater.confirmInstallDescription")}
          </p>
          {confirmCounts && confirmCounts.runningTurns > 0 ? (
            <Alert
              type="warning"
              showIcon
              message={t("updater.runningTurnsWarning", { count: confirmCounts.runningTurns })}
            />
          ) : null}
          {confirmCounts && confirmCounts.dirtyTabs > 0 ? (
            <Alert
              type="warning"
              showIcon
              message={t("updater.dirtyTabsWarning", { count: confirmCounts.dirtyTabs })}
            />
          ) : null}
        </div>
      </Modal>
    </>
  );
}
