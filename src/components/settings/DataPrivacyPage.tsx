import { useCallback, useEffect, useState } from "react";
import {
  DeleteOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { Button, Modal, Select, Spin, Tag, message } from "antd";
import { useTranslation } from "react-i18next";
import {
  clearAgentUsageHistory,
  getAgentUsageStorageStatus,
  rebuildAgentUsageHistory,
} from "@/lib/api";
import type { AgentUsageHistoryScope, AgentUsageStorageStatus } from "@/types";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import { ClipboardCacheSection } from "@/components/settings/ClipboardCacheSection";
import { SettingsSection } from "./SettingsSection";

type PendingOperation = "clear" | "rebuild" | null;

export function DataPrivacyPage() {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<AgentUsageStorageStatus | null>(null);
  const [scope, setScope] = useState<AgentUsageHistoryScope>("codex");
  const [loading, setLoading] = useState(true);
  const [pendingOperation, setPendingOperation] = useState<PendingOperation>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await getAgentUsageStorageStatus());
    } catch (error) {
      console.error("Failed to load usage storage status:", error);
      message.error(t("settings.usageData.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const formatTimestamp = (value: number | null | undefined, emptyKey: string) => {
    if (!value) return t(emptyKey);
    return new Intl.DateTimeFormat(i18n.resolvedLanguage, {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(value));
  };

  const handleRebuild = async () => {
    setPendingOperation("rebuild");
    try {
      setStatus(await rebuildAgentUsageHistory(scope));
      message.success(t("settings.usageData.rebuildSuccess"));
    } catch (error) {
      console.error("Failed to rebuild usage history:", error);
      message.error(t("settings.usageData.rebuildFailed"));
    } finally {
      setPendingOperation(null);
    }
  };

  const confirmClear = () => {
    Modal.confirm({
      title: t("settings.usageData.clearConfirmTitle"),
      content: t("settings.usageData.clearConfirmContent"),
      okText: t("settings.usageData.clear"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setPendingOperation("clear");
        try {
          setStatus(await clearAgentUsageHistory(scope));
          message.success(t("settings.usageData.clearSuccess"));
        } catch (error) {
          console.error("Failed to clear usage history:", error);
          message.error(t("settings.usageData.clearFailed"));
          throw error;
        } finally {
          setPendingOperation(null);
        }
      },
    });
  };

  return (
    <div className="app-settings-page">
      <SettingsPageHeader
        title={t("settings.usageData.title")}
        actions={
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadStatus()}>
            {t("settings.usageData.refresh")}
          </Button>
        }
      />

      <ClipboardCacheSection />

      <SettingsSection title={t("settings.usageData.storageTitle")}>
        {loading && !status ? (
          <div className="flex min-h-28 items-center justify-center"><Spin /></div>
        ) : (
          <div className="app-settings-stats">
            <StatusItem
              label={t("settings.usageData.retainedSessions")}
              value={String(status?.retainedSessions ?? 0)}
            />
            <StatusItem
              label={t("settings.usageData.lastSynced")}
              value={formatTimestamp(status?.lastSyncedAtMs, "settings.usageData.neverSynced")}
            />
            <StatusItem
              label={t("settings.usageData.clearedAt")}
              value={formatTimestamp(status?.clearedAtMs, "settings.usageData.notCleared")}
            />
          </div>
        )}

        {status?.lastError ? (
          <div
            className="mt-4 rounded-lg px-3 py-2 text-xs"
            style={{ background: "var(--cs-danger-hover)", color: "var(--cs-danger)" }}
          >
            {t("settings.usageData.lastError")}: {status.lastError}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title={<>{t("settings.usageData.privacyTitle")} <Tag color="success" className="!m-0">{t("settings.usageData.localOnly")}</Tag></>}>
        <p className="mb-1 text-xs leading-6 text-[var(--cs-text-secondary)]">{t("settings.usageData.included")}</p>
        <p className="mb-0 text-xs leading-6 text-[var(--cs-text-secondary)]">{t("settings.usageData.excluded")}</p>
      </SettingsSection>

      <SettingsSection title={t("settings.usageData.scope")}>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-[220px] flex-1">
            <Select<AgentUsageHistoryScope>
              value={scope}
              onChange={setScope}
              options={[
                { value: "codex", label: t("settings.usageData.scopeCodex") },
                { value: "all", label: t("settings.usageData.scopeAll") },
              ]}
              className="w-full max-w-80"
              aria-label={t("settings.usageData.scope")}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              icon={<ReloadOutlined />}
              loading={pendingOperation === "rebuild"}
              disabled={pendingOperation !== null && pendingOperation !== "rebuild"}
              onClick={() => void handleRebuild()}
            >
              {t("settings.usageData.rebuild")}
            </Button>
            <Button
              danger
              icon={<DeleteOutlined />}
              loading={pendingOperation === "clear"}
              disabled={pendingOperation !== null && pendingOperation !== "clear"}
              onClick={confirmClear}
            >
              {t("settings.usageData.clear")}
            </Button>
          </div>
        </div>

      </SettingsSection>
    </div>
  );
}

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="app-settings-stat">
      <div className="app-settings-stat__label">{label}</div>
      <div className="app-settings-stat__value">{value}</div>
    </div>
  );
}
