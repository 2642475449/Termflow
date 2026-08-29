import { message } from "antd";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import packageJson from "../../package.json";
import { onCurrentWindowCloseRequested } from "@/lib/api";
import {
  checkForApplicationUpdate,
  consumeInstalledUpdateVersion,
} from "@/lib/applicationUpdater";
import { useApplicationUpdateStore } from "@/store/slices/applicationUpdate";

const INITIAL_UPDATE_CHECK_DELAY_MS = 5_000;
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1_000;

export function useApplicationUpdater(automaticEnabled: boolean): void {
  const { t } = useTranslation();

  useEffect(() => {
    useApplicationUpdateStore.getState().patch({ currentVersion: packageJson.version });
    if (!automaticEnabled) return;

    const installedVersion = consumeInstalledUpdateVersion(window.localStorage, packageJson.version);
    if (installedVersion) {
      message.success(t("updater.installedSuccessfully", { version: installedVersion }));
    }

    const initialTimer = window.setTimeout(() => {
      void checkForApplicationUpdate();
    }, INITIAL_UPDATE_CHECK_DELAY_MS);
    const interval = window.setInterval(() => {
      void checkForApplicationUpdate();
    }, UPDATE_CHECK_INTERVAL_MS);

    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, [automaticEnabled, t]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onCurrentWindowCloseRequested((event) => {
      if (useApplicationUpdateStore.getState().phase !== "downloading") return;
      event.preventDefault();
      message.warning(t("updater.keepOpenDuringDownload"));
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch((error) => {
      console.error("Failed to register application update close guard:", error);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [t]);
}
