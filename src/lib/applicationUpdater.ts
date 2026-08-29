import type { Update } from "@tauri-apps/plugin-updater";
import packageJson from "../../package.json";
import {
  checkApplicationUpdate,
  closeApplicationUpdate,
  downloadApplicationUpdate,
  installApplicationUpdate,
  savePersistentSettings,
} from "@/lib/api";
import { applyUpdaterDownloadEvent, createUpdateProgress } from "@/lib/updateProgress";
import { getPersistentSettingsSnapshot } from "@/store";
import {
  useApplicationUpdateStore,
  type ApplicationUpdatePhase,
} from "@/store/slices/applicationUpdate";

const CHECK_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const PENDING_UPDATE_VERSION_KEY = "termflow.pending-update-version";

// 仍处于"已持有更新资源"状态的阶段；命中时直接复用 pendingUpdate，不再重新请求。
const ACTIVE_UPDATE_PHASES: readonly ApplicationUpdatePhase[] = [
  "available",
  "downloading",
  "ready",
  "installing",
];

export const TERMFLOW_RELEASES_URL = "https://github.com/2642475449/Termflow/releases/latest";

export type ApplicationUpdateCheckResult =
  | { status: "up-to-date"; currentVersion: string }
  | { status: "available"; currentVersion: string; version: string }
  | { status: "error"; currentVersion: string; error: string };

let pendingUpdate: Update | null = null;
let checkPromise: Promise<ApplicationUpdateCheckResult> | null = null;
let downloadPromise: Promise<void> | null = null;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentVersion(): string {
  return pendingUpdate?.currentVersion || packageJson.version;
}

export function markPendingUpdateVersion(storage: Storage, version: string): void {
  storage.setItem(PENDING_UPDATE_VERSION_KEY, version);
}

export function consumeInstalledUpdateVersion(
  storage: Storage,
  installedVersion: string,
): string | null {
  const pendingVersion = storage.getItem(PENDING_UPDATE_VERSION_KEY);
  if (!pendingVersion) return null;
  storage.removeItem(PENDING_UPDATE_VERSION_KEY);
  return pendingVersion === installedVersion ? pendingVersion : null;
}

export function clearPendingUpdateVersion(storage: Storage): void {
  storage.removeItem(PENDING_UPDATE_VERSION_KEY);
}

export async function checkForApplicationUpdate(
  options: { manual?: boolean } = {},
): Promise<ApplicationUpdateCheckResult> {
  const state = useApplicationUpdateStore.getState();
  const version = currentVersion();

  if (pendingUpdate && ACTIVE_UPDATE_PHASES.includes(state.phase)) {
    if (options.manual) state.openModal();
    return { status: "available", currentVersion: version, version: pendingUpdate.version };
  }
  if (checkPromise) {
    const result = await checkPromise;
    if (options.manual && result.status !== "up-to-date") {
      useApplicationUpdateStore.getState().openModal();
    }
    return result;
  }

  state.patch({
    phase: "checking",
    currentVersion: version,
    error: null,
    errorStage: null,
  });

  checkPromise = (async () => {
    try {
      const update = await checkApplicationUpdate({ timeout: CHECK_TIMEOUT_MS });
      if (!update) {
        useApplicationUpdateStore.getState().reset(version);
        return { status: "up-to-date", currentVersion: version } as const;
      }

      if (pendingUpdate && pendingUpdate !== update) {
        void closeApplicationUpdate(pendingUpdate).catch((error) => {
          console.warn("Failed to close superseded application update:", error);
        });
      }
      pendingUpdate = update;
      useApplicationUpdateStore.getState().patch({
        phase: "available",
        currentVersion: update.currentVersion,
        availableVersion: update.version,
        releaseNotes: update.body ?? null,
        downloadedBytes: 0,
        totalBytes: null,
        percent: null,
        error: null,
        errorStage: null,
        // 自动检查不应改动弹窗开合，否则会静默关掉用户正打开的弹窗。
        ...(options.manual ? { modalOpen: true } : {}),
      });
      void downloadPendingApplicationUpdate();
      return {
        status: "available",
        currentVersion: update.currentVersion,
        version: update.version,
      } as const;
    } catch (error) {
      const detail = errorText(error);
      console.error("Failed to check for application updates:", error);
      useApplicationUpdateStore.getState().patch({
        phase: "error",
        currentVersion: version,
        error: detail,
        errorStage: "check",
        ...(options.manual ? { modalOpen: true } : {}),
      });
      return { status: "error", currentVersion: version, error: detail } as const;
    } finally {
      checkPromise = null;
    }
  })();

  return await checkPromise;
}

export async function downloadPendingApplicationUpdate(): Promise<void> {
  if (downloadPromise) return await downloadPromise;
  const update = pendingUpdate;
  if (!update) {
    await checkForApplicationUpdate({ manual: true });
    return;
  }

  useApplicationUpdateStore.getState().patch({
    phase: "downloading",
    downloadedBytes: 0,
    totalBytes: null,
    percent: null,
    error: null,
    errorStage: null,
  });

  downloadPromise = (async () => {
    try {
      let progress = createUpdateProgress();
      let lastEmittedPercent = Number.NaN;
      let lastEmittedBytesStep = -1;
      await downloadApplicationUpdate(
        update,
        (event) => {
          progress = applyUpdaterDownloadEvent(progress, event);
          if (event.event === "Progress") {
            // 进度事件高频到达，只在显示粒度变化时写 store。
            const percentStep = progress.percent ?? -1;
            const bytesStep = Math.floor(progress.downloadedBytes / 131_072);
            if (percentStep === lastEmittedPercent && bytesStep === lastEmittedBytesStep) return;
            lastEmittedPercent = percentStep;
            lastEmittedBytesStep = bytesStep;
          }
          useApplicationUpdateStore.getState().patch({
            downloadedBytes: progress.downloadedBytes,
            totalBytes: progress.totalBytes,
            percent: progress.percent,
          });
        },
        { timeout: DOWNLOAD_TIMEOUT_MS },
      );
      useApplicationUpdateStore.getState().patch({
        phase: "ready",
        percent: 100,
        error: null,
        errorStage: null,
      });
    } catch (error) {
      const detail = errorText(error);
      console.error("Failed to download application update:", error);
      useApplicationUpdateStore.getState().patch({
        phase: "error",
        error: detail,
        errorStage: "download",
      });
    } finally {
      downloadPromise = null;
    }
  })();

  await downloadPromise;
}

export async function installPendingApplicationUpdate(): Promise<void> {
  const update = pendingUpdate;
  if (!update || useApplicationUpdateStore.getState().phase === "installing") return;

  useApplicationUpdateStore.getState().patch({
    phase: "installing",
    modalOpen: true,
    error: null,
    errorStage: null,
  });

  try {
    await savePersistentSettings(getPersistentSettingsSnapshot());
    markPendingUpdateVersion(window.localStorage, update.version);
    await installApplicationUpdate(update);
  } catch (error) {
    const detail = errorText(error);
    clearPendingUpdateVersion(window.localStorage);
    console.error("Failed to install application update:", error);
    useApplicationUpdateStore.getState().patch({
      phase: "ready",
      modalOpen: true,
      error: detail,
      errorStage: "install",
    });
  }
}

export function resetApplicationUpdaterForTests(): void {
  pendingUpdate = null;
  checkPromise = null;
  downloadPromise = null;
  useApplicationUpdateStore.getState().reset(packageJson.version);
}
