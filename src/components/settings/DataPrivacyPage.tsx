import { useCallback, useEffect, useState } from "react";
import {
  DatabaseOutlined,
  DeleteOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
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
    <div className="mx-auto max-w-5xl">
      <SettingsPageHeader
        title={t("settings.usageData.title")}
        description={t("settings.usageData.subtitle")}
        actions={
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadStatus()}>
            {t("settings.usageData.refresh")}
          </Button>
        }
      />

      <section
        className="app-glass-card mb-4 rounded-xl p-5"
        style={{ background: "var(--cs-bg-card)", border: "1px solid var(--cs-border-card)" }}
      >
        <div className="mb-4 flex items-center gap-3">
          <DatabaseOutlined className="text-lg" style={{ color: "var(--cs-primary)" }} />
          <div>
            <div className="font-semibold" style={{ color: "var(--cs-text-primary)" }}>
              {t("settings.usageData.storageTitle")}
            </div>
            <div className="mt-1 text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
              {t("settings.usageData.storageDescription")}
            </div>
          </div>
        </div>

        {loading && !status ? (
          <div className="flex min-h-28 items-center justify-center"><Spin /></div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
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
      </section>

      <section
        className="app-glass-card mb-4 rounded-xl p-5"
        style={{ background: "var(--cs-bg-card)", border: "1px solid var(--cs-border-card)" }}
      >
        <div className="flex items-start gap-3">
          <SafetyCertificateOutlined className="mt-0.5 text-lg" style={{ color: "var(--cs-success)" }} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold" style={{ color: "var(--cs-text-primary)" }}>
                {t("settings.usageData.privacyTitle")}
              </span>
              <Tag color="success" className="m-0">{t("settings.usageData.localOnly")}</Tag>
            </div>
            <div className="mt-2 text-sm leading-6" style={{ color: "var(--cs-text-secondary)" }}>
              {t("settings.usageData.included")}
            </div>
            <div className="text-sm leading-6" style={{ color: "var(--cs-text-tertiary)" }}>
              {t("settings.usageData.excluded")}
            </div>
          </div>
        </div>
      </section>

      <section
        className="app-glass-card rounded-xl p-5"
        style={{ background: "var(--cs-bg-card)", border: "1px solid var(--cs-border-card)" }}
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-[220px] flex-1">
            <div className="mb-2 text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>
              {t("settings.usageData.scope")}
            </div>
            <Select<AgentUsageHistoryScope>
              value={scope}
              onChange={setScope}
              options={[
                { value: "codex", label: t("settings.usageData.scopeCodex") },
                { value: "all", label: t("settings.usageData.scopeAll") },
              ]}
              style={{ width: "min(100%, 320px)" }}
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
        <div className="mt-4 grid gap-2 text-xs leading-5" style={{ color: "var(--cs-text-tertiary)" }}>
          <div>{t("settings.usageData.rebuildDescription")}</div>
          <div>{t("settings.usageData.clearDescription")}</div>
        </div>
      </section>
    </div>
  );
}

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg px-3 py-3" style={{ background: "var(--cs-bg-hover)" }}>
      <div className="text-[11px]" style={{ color: "var(--cs-text-tertiary)" }}>{label}</div>
      <div className="mt-1 break-words text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>
        {value}
      </div>
    </div>
  );
}
