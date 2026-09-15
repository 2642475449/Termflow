import { useEffect } from "react";
import { Button, message } from "antd";
import { DeleteOutlined, ReloadOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { refreshClipboardCache, useClipboardCacheStore } from "@/store/slices/clipboardCache";

export function ClipboardCacheSection() {
  const { t, i18n } = useTranslation();
  const { status, loading, cleaning, error, syncError } = useClipboardCacheStore();
  useEffect(() => { void refreshClipboardCache().catch(console.error); }, []);
  const refresh = async (clean = false) => {
    try {
      await refreshClipboardCache(clean);
      if (clean) message.success(t("settings.clipboardCache.cleaned"));
    } catch (error) {
      console.error("Screenshot cache operation failed:", error);
      message.error(t("settings.clipboardCache.failed"));
    }
  };
  const size = (bytes: number) => `${new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 2 }).format(bytes / 1024 / 1024)} MiB`;
  return (
    <section className="app-glass-card mb-4 rounded-xl border border-[var(--cs-border-card)] bg-[var(--cs-bg-card)] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="m-0 font-semibold text-[var(--cs-text-primary)]">{t("settings.clipboardCache.title")}</h3>
        <div className="flex gap-2">
          <Button icon={<ReloadOutlined />} loading={loading} disabled={cleaning} onClick={() => void refresh()}>{t("settings.usageData.refresh")}</Button>
          <Button icon={<DeleteOutlined />} loading={cleaning} disabled={loading || !status || status.reclaimableBytes === 0 || Boolean(syncError)} onClick={() => void refresh(true)}>{t("settings.clipboardCache.clean")}</Button>
        </div>
      </div>
      <p className="mt-3 text-sm leading-6 text-[var(--cs-text-secondary)]">{t("settings.clipboardCache.policy", { hours: status?.pendingHours ?? 24, days: status?.retentionDays ?? 7 })}</p>
      {status ? (
        <>
          <div className="grid gap-3 text-sm sm:grid-cols-3">
            {[
              [t("settings.clipboardCache.total"), `${size(status.totalBytes)} / ${size(status.limitBytes)}`],
              [t("settings.clipboardCache.protected"), size(status.protectedBytes)],
              [t("settings.clipboardCache.reclaimable"), size(status.reclaimableBytes)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-[var(--cs-bg-hover)] p-3">
                <div className="text-xs text-[var(--cs-text-tertiary)]">{label}</div>
                <div className="mt-1 text-[var(--cs-text-primary)]">{value}</div>
              </div>
            ))}
          </div>
          <p className="mb-0 mt-3 break-all text-xs text-[var(--cs-text-tertiary)]">{status.cachePath}</p>
          {status.legacyBytes > 0 ? <p className="mb-0 mt-2 text-xs text-[var(--cs-text-tertiary)]">{t("settings.clipboardCache.legacy", { size: size(status.legacyBytes) })}</p> : null}
        </>
      ) : null}
      {error || syncError ? <p role="alert" className="mb-0 mt-3 text-sm text-[var(--cs-danger)]">{t(syncError ? "settings.clipboardCache.syncFailed" : "settings.clipboardCache.failed")}</p> : null}
    </section>
  );
}
