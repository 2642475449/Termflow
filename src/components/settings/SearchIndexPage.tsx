import { DatabaseOutlined, DeleteOutlined, FolderOpenOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, InputNumber, Modal, Switch, Tag, message } from "antd";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import {
  clearSearchIndexCache,
  getSearchIndexStorageStatus,
  getSearchIndexStatus,
  rebuildProjectIndex,
  setSearchIndexStorage,
  setProjectIndexEnabled,
} from "@/lib/api";
import { useAppStore } from "@/store";
import type { ProjectSearchIndexStatus, SearchIndexStorageStatus } from "@/types";

interface IndexSettingRowProps {
  title: string;
  description: ReactNode;
  tag: ReactNode;
  checked?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onChange?: (checked: boolean) => void;
}

function IndexSettingRow({
  title,
  description,
  tag,
  checked = false,
  disabled = false,
  loading = false,
  onChange,
}: IndexSettingRowProps) {
  return (
    <div className="flex items-center justify-between gap-6 px-5 py-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>
            {title}
          </span>
          {tag}
        </div>
        <div className="mt-1 text-xs leading-5" style={{ color: "var(--cs-text-tertiary)" }}>
          {description}
        </div>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        loading={loading}
        aria-label={title}
        onChange={onChange}
      />
    </div>
  );
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** unit;
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

const BYTES_PER_GIB = 1024 ** 3;

function selectedCacheRoot(directory: string): string {
  return `${directory.replace(/[\\/]+$/, "")}/Termflow Search Index`;
}

export function SearchIndexPage() {
  const { t } = useTranslation();
  const currentProject = useAppStore((state) => state.currentProject);
  const projectPath = currentProject?.path ?? null;
  const [status, setStatus] = useState<ProjectSearchIndexStatus | null>(null);
  const [statusProjectPath, setStatusProjectPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [storage, setStorage] = useState<SearchIndexStorageStatus | null>(null);
  const [storageLoading, setStorageLoading] = useState(true);
  const [storageSaving, setStorageSaving] = useState(false);
  const [quotaGiB, setQuotaGiB] = useState(5);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  async function refreshStorage() {
    setStorageLoading(true);
    try {
      const nextStorage = await getSearchIndexStorageStatus();
      setStorage(nextStorage);
      setQuotaGiB(Number((nextStorage.quotaBytes / BYTES_PER_GIB).toFixed(2)));
    } catch (error) {
      message.error(t("settings.searchIndex.storageLoadFailed", { error: String(error) }));
    } finally {
      setStorageLoading(false);
    }
  }

  useEffect(() => {
    void refreshStorage();
  }, []); // The storage setting is global and only needs an initial load.

  useEffect(() => {
    if (!projectPath) {
      setStatus(null);
      setStatusProjectPath(null);
      setLoading(false);
      setLoadError(false);
      return;
    }

    let disposed = false;
    setLoading(true);
    setLoadError(false);
    getSearchIndexStatus(projectPath)
      .then((nextStatus) => {
        if (!disposed) {
          setStatus(nextStatus);
          setStatusProjectPath(projectPath);
        }
      })
      .catch((error) => {
        if (!disposed) {
          setStatus(null);
          setStatusProjectPath(null);
          setLoadError(true);
          message.error(t("settings.searchIndex.loadFailed", { error: String(error) }));
        }
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });

    return () => {
      disposed = true;
    };
  }, [projectPath, t]);

  useEffect(() => {
    if (!projectPath) return;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    listen<ProjectSearchIndexStatus>("search-index-status", (event) => {
      if (disposed) return;
      const normalize = (value: string) => value.replaceAll("\\", "/").toLocaleLowerCase();
      if (normalize(event.payload.projectPath) !== normalize(projectPath)) return;
      setStatus(event.payload);
      setStatusProjectPath(projectPath);
      setLoadError(false);
      if (event.payload.state === "ready") void refreshStorage();
    })
      .then((nextUnsubscribe) => {
        if (disposed) nextUnsubscribe();
        else unsubscribe = nextUnsubscribe;
      })
      .catch((error) => {
        if (!disposed) {
          setLoadError(true);
          message.error(t("settings.searchIndex.eventFailed", { error: String(error) }));
        }
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [projectPath, t]);

  const statusBelongsToCurrentProject = statusProjectPath === projectPath;
  const activeBuild =
    statusBelongsToCurrentProject &&
    (status?.state === "preflight" || status?.state === "building");

  useEffect(() => {
    if (!projectPath || !activeBuild) return;
    let disposed = false;
    const timer = window.setInterval(() => {
      getSearchIndexStatus(projectPath)
        .then((nextStatus) => {
          if (!disposed) {
            setStatus(nextStatus);
            setStatusProjectPath(projectPath);
            setLoadError(false);
          }
        })
        .catch(() => {
          if (!disposed) setLoadError(true);
        });
    }, 700);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [activeBuild, projectPath]);

  async function changeProjectIndexEnabled(enabled: boolean) {
    if (!projectPath || saving) return;
    setSaving(true);
    try {
      const nextStatus = await setProjectIndexEnabled(projectPath, enabled);
      setStatus(nextStatus);
      setStatusProjectPath(projectPath);
      setLoadError(false);
      message.success(
        t(enabled ? "settings.searchIndex.enabledSuccess" : "settings.searchIndex.disabledSuccess")
      );
    } catch (error) {
      message.error(t("settings.searchIndex.saveFailed", { error: String(error) }));
    } finally {
      setSaving(false);
    }
  }

  async function rebuild() {
    if (!projectPath || rebuilding) return;
    setRebuilding(true);
    try {
      const nextStatus = await rebuildProjectIndex(projectPath);
      setStatus(nextStatus);
      setStatusProjectPath(projectPath);
      setLoadError(false);
      message.success(t("settings.searchIndex.rebuildStarted"));
    } catch (error) {
      message.error(t("settings.searchIndex.rebuildFailed", { error: String(error) }));
    } finally {
      setRebuilding(false);
    }
  }

  async function chooseCacheRoot() {
    if (storageSaving) return;
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: t("settings.searchIndex.chooseStorageFolder"),
    });
    if (!selected) return;
    setStorageSaving(true);
    try {
      const nextStorage = await setSearchIndexStorage(
        selectedCacheRoot(selected as string),
        Math.round(quotaGiB * BYTES_PER_GIB)
      );
      setStorage(nextStorage);
      setQuotaGiB(Number((nextStorage.quotaBytes / BYTES_PER_GIB).toFixed(2)));
      message.success(t("settings.searchIndex.storageMoved"));
    } catch (error) {
      message.error(t("settings.searchIndex.storageSaveFailed", { error: String(error) }));
    } finally {
      setStorageSaving(false);
    }
  }

  async function saveQuota() {
    if (!storage || storageSaving) return;
    setStorageSaving(true);
    try {
      const nextStorage = await setSearchIndexStorage(
        storage.cacheRoot,
        Math.round(quotaGiB * BYTES_PER_GIB)
      );
      setStorage(nextStorage);
      setQuotaGiB(Number((nextStorage.quotaBytes / BYTES_PER_GIB).toFixed(2)));
      message.success(t("settings.searchIndex.quotaSaved"));
    } catch (error) {
      message.error(t("settings.searchIndex.storageSaveFailed", { error: String(error) }));
    } finally {
      setStorageSaving(false);
    }
  }

  async function clearCache() {
    setClearing(true);
    try {
      const nextStorage = await clearSearchIndexCache();
      setStorage(nextStorage);
      setClearDialogOpen(false);
      setStatus(null);
      setStatusProjectPath(null);
      message.success(t("settings.searchIndex.cacheCleared"));
      if (projectPath) {
        const nextStatus = await getSearchIndexStatus(projectPath);
        setStatus(nextStatus);
        setStatusProjectPath(projectPath);
      }
    } catch (error) {
      message.error(t("settings.searchIndex.clearFailed", { error: String(error) }));
    } finally {
      setClearing(false);
    }
  }

  const projectIndexEnabled = statusBelongsToCurrentProject && status?.enabled === true;
  const statusTag = useMemo(() => {
    if (!projectPath) return <Tag className="m-0">{t("settings.searchIndex.openProjectFirst")}</Tag>;
    if (loading) return <Tag className="m-0">{t("settings.searchIndex.loading")}</Tag>;
    if (loadError) {
      return (
        <Tag color="warning" className="m-0">
          {t("settings.searchIndex.statusUnavailable")}
        </Tag>
      );
    }
    const state = statusBelongsToCurrentProject ? status?.state : "disabled";
    switch (state) {
      case "preflight":
        return <Tag color="processing">{t("settings.searchIndex.preflight")}</Tag>;
      case "building":
        return <Tag color="processing">{t("settings.searchIndex.building")}</Tag>;
      case "ready":
        return <Tag color="success">{t("settings.searchIndex.ready")}</Tag>;
      case "stale":
        return <Tag color="warning">{t("settings.searchIndex.stale")}</Tag>;
      case "failed":
        return <Tag color="error">{t("settings.searchIndex.failed")}</Tag>;
      case "unsupported":
        return <Tag color="warning">{t("settings.searchIndex.unsupported")}</Tag>;
      default:
        return null;
    }
  }, [loadError, loading, projectPath, status?.state, statusBelongsToCurrentProject, t]);

  const statusDescription = useMemo(() => {
    if (!projectIndexEnabled || !status) {
      return t("settings.searchIndex.instantSearchDescription");
    }
    if (status.state === "preflight") return t("settings.searchIndex.preflightDescription");
    if (status.state === "building") return t("settings.searchIndex.buildingDescription");
    if (status.state === "ready") return t("settings.searchIndex.readyDescription");
    if (status.state === "stale") return t("settings.searchIndex.staleDescription");
    if (status.state === "unsupported") return t("settings.searchIndex.unsupportedDescription");
    if (status.state === "failed") {
      return t("settings.searchIndex.failedDescription", { error: status.error ?? "Unknown error" });
    }
    return t("settings.searchIndex.instantSearchDescription");
  }, [projectIndexEnabled, status, t]);

  return (
    <div className="mx-auto max-w-5xl">
      <SettingsPageHeader
        title={t("settings.searchIndex.title")}
        description={t("settings.searchIndex.subtitle")}
      />

      <div
        className="mb-2 flex items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-widest"
        style={{ color: "var(--cs-text-tertiary)" }}
      >
        <DatabaseOutlined />
        {t("settings.searchIndex.repositories")}
      </div>
      <section
        className="app-glass-card overflow-hidden rounded-xl"
        style={{ background: "var(--cs-bg-card)", border: "1px solid var(--cs-border-card)" }}
      >
        <IndexSettingRow
          title={t("settings.searchIndex.autoIndexTitle")}
          description={t("settings.searchIndex.autoIndexDescription")}
          tag={<Tag className="m-0">{t("settings.searchIndex.comingSoon")}</Tag>}
          disabled
        />
        <div style={{ borderTop: "1px solid var(--cs-border-card)" }}>
          <IndexSettingRow
            title={t("settings.searchIndex.instantSearchTitle")}
            description={statusDescription}
            tag={statusTag}
            checked={projectIndexEnabled}
            disabled={!projectPath || loading || saving}
            loading={loading || saving}
            onChange={(enabled) => void changeProjectIndexEnabled(enabled)}
          />
        </div>
        {projectIndexEnabled && status ? (
          <div
            className="px-5 py-4"
            style={{ borderTop: "1px solid var(--cs-border-card)" }}
          >
            <div
              className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs"
              style={{ color: "var(--cs-text-tertiary)" }}
            >
              <span>
                {t("settings.searchIndex.searchableFiles", { count: status.indexedFiles })}
              </span>
              <span>
                {t("settings.searchIndex.candidateFiles", {
                  count: status.totalFiles ?? status.processedFiles,
                })}
              </span>
              <span>{t("settings.searchIndex.skippedNonTextFiles", { count: status.skippedFiles })}</span>
              {status.indexSizeBytes > 0 ? (
                <span>
                  {t("settings.searchIndex.indexSize", { size: formatBytes(status.indexSizeBytes) })}
                </span>
              ) : null}
              {status.updatedAt ? (
                <span>
                  {t("settings.searchIndex.updatedAt", {
                    time: new Date(status.updatedAt).toLocaleString(),
                  })}
                </span>
              ) : null}
            </div>
            <div className="mt-2 text-xs leading-5" style={{ color: "var(--cs-text-tertiary)" }}>
              {t("settings.searchIndex.excludedDirectories")}
            </div>
            <div className="mt-3">
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={rebuilding}
                disabled={activeBuild}
                onClick={() => void rebuild()}
              >
                {t("settings.searchIndex.rebuild")}
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <div
        className="mb-2 mt-6 flex items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-widest"
        style={{ color: "var(--cs-text-tertiary)" }}
      >
        <DatabaseOutlined />
        {t("settings.searchIndex.storage")}
      </div>
      <section
        className="app-glass-card overflow-hidden rounded-xl"
        style={{ background: "var(--cs-bg-card)", border: "1px solid var(--cs-border-card)" }}
      >
        <div className="px-5 py-4">
          <div className="text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>
            {t("settings.searchIndex.storageLocation")}
          </div>
          <div className="mt-1 break-all text-xs leading-5" style={{ color: "var(--cs-text-tertiary)" }}>
            {storageLoading ? t("settings.searchIndex.loading") : storage?.cacheRoot}
          </div>
          <div className="mt-3">
            <Button
              size="small"
              icon={<FolderOpenOutlined />}
              loading={storageSaving}
              disabled={activeBuild || clearing}
              onClick={() => void chooseCacheRoot()}
            >
              {t("settings.searchIndex.changeStorageFolder")}
            </Button>
          </div>
        </div>
        <div className="px-5 py-4" style={{ borderTop: "1px solid var(--cs-border-card)" }}>
          <div className="text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>
            {t("settings.searchIndex.storageLimit")}
          </div>
          <div className="mt-1 text-xs leading-5" style={{ color: "var(--cs-text-tertiary)" }}>
            {t("settings.searchIndex.storageLimitDescription", {
              used: formatBytes(storage?.usedBytes ?? 0),
              projects: storage?.projectCount ?? 0,
            })}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <InputNumber
              min={0.25}
              max={1024}
              step={0.25}
              value={quotaGiB}
              disabled={storageLoading || storageSaving || activeBuild || clearing}
              addonAfter="GiB"
              aria-label={t("settings.searchIndex.storageLimit")}
              onChange={(value) => setQuotaGiB(typeof value === "number" ? value : 5)}
            />
            <Button
              size="small"
              loading={storageSaving}
              disabled={storageLoading || activeBuild || clearing}
              onClick={() => void saveQuota()}
            >
              {t("settings.searchIndex.saveStorageLimit")}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4" style={{ borderTop: "1px solid var(--cs-border-card)" }}>
          <div>
            <div className="text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>
              {t("settings.searchIndex.clearCache")}
            </div>
            <div className="mt-1 text-xs leading-5" style={{ color: "var(--cs-text-tertiary)" }}>
              {t("settings.searchIndex.clearCacheDescription")}
            </div>
          </div>
          <Button
            danger
            size="small"
            icon={<DeleteOutlined />}
            disabled={storageLoading || activeBuild || storageSaving || clearing || (storage?.usedBytes ?? 0) === 0}
            onClick={() => setClearDialogOpen(true)}
          >
            {t("settings.searchIndex.clearCache")}
          </Button>
        </div>
      </section>

      <Modal
        open={clearDialogOpen}
        title={t("settings.searchIndex.clearCacheConfirmTitle")}
        okText={t("settings.searchIndex.clearCache")}
        okButtonProps={{ danger: true }}
        cancelText={t("common.cancel")}
        confirmLoading={clearing}
        onCancel={() => !clearing && setClearDialogOpen(false)}
        onOk={() => void clearCache()}
      >
        <p>{t("settings.searchIndex.clearCacheConfirmDescription")}</p>
      </Modal>
    </div>
  );
}

export default SearchIndexPage;
