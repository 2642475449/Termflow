import { useState } from "react";
import { NotificationOutlined } from "@ant-design/icons";
import { Button, message, Tooltip } from "antd";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/en";
import "dayjs/locale/ja";
import "dayjs/locale/zh-cn";
import "dayjs/locale/zh-tw";
import { useTranslation } from "react-i18next";
import { sendSessionNotification } from "@/lib/api";
import { getAgentDisplayName, getAgentIdsWithCapability } from "@/lib/agents";
import { playNotificationSound } from "@/lib/sounds";
import { useAppStore } from "@/store";

dayjs.extend(relativeTime);

const DIAGNOSTIC_AGENTS = getAgentIdsWithCapability("statusEvents");

function dayjsLocale(locale: string) {
  if (locale.startsWith("zh-TW") || locale.startsWith("zh_Hant")) return "zh-tw";
  if (locale.startsWith("zh")) return "zh-cn";
  if (locale.startsWith("ja")) return "ja";
  return "en";
}

export function NotificationDiagnostics() {
  const { t, i18n } = useTranslation();
  const [testing, setTesting] = useState(false);
  const diagnostics = useAppStore((state) => state.attentionDiagnostics);
  const currentProject = useAppStore((state) => state.currentProject);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const notificationEnabled = useAppStore((state) => state.notificationEnabled);
  const soundEnabled = useAppStore((state) => state.notificationSoundEnabled);
  const soundMap = useAppStore((state) => state.notificationSoundMap);
  const recordNotificationDelivery = useAppStore((state) => state.recordNotificationDelivery);
  const systemDelivery = diagnostics.lastNotifications?.system ?? diagnostics.lastNotification;
  const feishuDelivery = diagnostics.lastNotifications?.feishu;
  const configuredHookCount = DIAGNOSTIC_AGENTS.filter(
    (agentId) => diagnostics.hooks[agentId]?.configured
  ).length;

  async function handleTestNotification() {
    if (!currentProject || testing) return;
    setTesting(true);
    const eventId = `attention-test:${Date.now()}`;
    try {
      if (soundEnabled) playNotificationSound(soundMap.taskComplete);
      const permission = (await isPermissionGranted()) ? "granted" : await requestPermission();
      if (permission !== "granted") {
        recordNotificationDelivery({
          channel: "system",
          eventId,
          eventType: "diagnostic_test",
          status: "suppressed",
          reason: "permission-denied",
          updatedAt: Date.now(),
          test: true,
        });
        message.warning(t("sidebar.attentionDiagnostics.testPermissionDenied"));
        return;
      }
      await sendSessionNotification(
        t("sidebar.attentionDiagnostics.testTitle"),
        t("sidebar.attentionDiagnostics.testBody"),
        activeSessionId ?? "",
        currentProject.path
      );
      recordNotificationDelivery({
        channel: "system",
        eventId,
        eventType: "diagnostic_test",
        status: "sent",
        updatedAt: Date.now(),
        test: true,
      });
      message.success(t("sidebar.attentionDiagnostics.testSent"));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      recordNotificationDelivery({
        channel: "system",
        eventId,
        eventType: "diagnostic_test",
        status: "failed",
        error: errorMessage,
        updatedAt: Date.now(),
        test: true,
      });
      message.error(t("sidebar.attentionDiagnostics.testFailed", { error: errorMessage }));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="px-4 py-3 text-xs" style={{ color: "var(--cs-text-secondary)" }}>
      <div className="flex items-center justify-between gap-3 py-1">
        <span>{t("sidebar.attentionDiagnostics.hooks")}</span>
        <span style={{ color: configuredHookCount === DIAGNOSTIC_AGENTS.length ? "#55b685" : "#d99b2b" }}>
          {configuredHookCount}/{DIAGNOSTIC_AGENTS.length}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5 pb-2">
        {DIAGNOSTIC_AGENTS.map((agentId) => {
          const hook = diagnostics.hooks[agentId];
          return (
            <Tooltip
              key={agentId}
              title={hook?.error || hook?.detail || t("sidebar.attentionDiagnostics.notChecked")}
            >
              <span
                className="rounded px-2 py-1 text-[11px]"
                style={{
                  color: hook?.configured
                    ? "#55b685"
                    : hook
                      ? "#e06060"
                      : "var(--cs-text-tertiary)",
                  background: "var(--cs-bg-hover)",
                }}
              >
                {getAgentDisplayName(agentId)}
              </span>
            </Tooltip>
          );
        })}
      </div>

      <div className="border-t py-2" style={{ borderColor: "var(--cs-border-card)" }}>
        <div className="flex items-center justify-between gap-3">
          <span>{t("sidebar.attentionDiagnostics.lastEvent")}</span>
          <span className="truncate" style={{ color: "var(--cs-text-primary)" }}>
            {diagnostics.lastEvent
              ? `${diagnostics.lastEvent.eventType} · ${diagnostics.lastEvent.outcome}`
              : t("sidebar.attentionDiagnostics.none")}
          </span>
        </div>
        {diagnostics.lastEvent && (
          <div className="mt-1 text-right text-[11px]" style={{ color: "var(--cs-text-tertiary)" }}>
            {dayjs(diagnostics.lastEvent.receivedAt)
              .locale(dayjsLocale(i18n.language))
              .fromNow()}
          </div>
        )}
      </div>

      <div className="border-t py-2" style={{ borderColor: "var(--cs-border-card)" }}>
        <div className="flex items-center justify-between gap-3">
          <span>{t("sidebar.attentionDiagnostics.lastNotification")}</span>
          <span className="truncate" style={{ color: "var(--cs-text-primary)" }}>
            {systemDelivery
              ? t(`sidebar.attentionDiagnostics.delivery.${systemDelivery.status}`)
              : t("sidebar.attentionDiagnostics.none")}
          </span>
        </div>
        {systemDelivery?.reason && (
          <div className="mt-1 text-right text-[11px]" style={{ color: "#d99b2b" }}>
            {t(`sidebar.attentionDiagnostics.reason.${systemDelivery.reason}`)}
          </div>
        )}
        {systemDelivery?.error && (
          <Tooltip title={systemDelivery.error}>
            <div className="mt-1 truncate text-right text-[11px]" style={{ color: "#e06060" }}>
              {systemDelivery.error}
            </div>
          </Tooltip>
        )}
      </div>

      <div className="border-t py-2" style={{ borderColor: "var(--cs-border-card)" }}>
        <div className="flex items-center justify-between gap-3">
          <span>{t("settings.notifications.feishu.channelName")}</span>
          <span className="truncate" style={{ color: "var(--cs-text-primary)" }}>
            {feishuDelivery
              ? t(`sidebar.attentionDiagnostics.delivery.${feishuDelivery.status}`)
              : t("sidebar.attentionDiagnostics.none")}
          </span>
        </div>
        {feishuDelivery?.reason && (
          <div className="mt-1 text-right text-[11px]" style={{ color: "#d99b2b" }}>
            {t(`sidebar.attentionDiagnostics.reason.${feishuDelivery.reason}`)}
          </div>
        )}
        {feishuDelivery?.error && (
          <Tooltip title={feishuDelivery.error}>
            <div className="mt-1 truncate text-right text-[11px]" style={{ color: "#e06060" }}>
              {feishuDelivery.error}
            </div>
          </Tooltip>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t pt-3" style={{ borderColor: "var(--cs-border-card)" }}>
        <div className="min-w-0 text-[11px]">
          <div style={{ color: notificationEnabled ? "#55b685" : "#d99b2b" }}>
            {t("sidebar.attentionDiagnostics.switchStatus", {
              status: t(notificationEnabled ? "common.on" : "common.off"),
            })}
          </div>
          <div style={{ color: soundEnabled ? "#55b685" : "var(--cs-text-tertiary)" }}>
            {t("sidebar.attentionDiagnostics.soundStatus", {
              status: t(soundEnabled ? "common.on" : "common.off"),
            })}
          </div>
        </div>
        <Button
          size="small"
          icon={<NotificationOutlined />}
          loading={testing}
          disabled={!currentProject}
          onClick={() => void handleTestNotification()}
        >
          {t("sidebar.attentionDiagnostics.test")}
        </Button>
      </div>
    </div>
  );
}
