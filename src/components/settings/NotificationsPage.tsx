import { useEffect, useState, type ReactNode } from "react";
import { NotificationOutlined, PlayCircleOutlined, SoundOutlined } from "@ant-design/icons";
import { Button, Input, message, Popconfirm, Select, Spin, Switch, Tag } from "antd";
import { useTranslation } from "react-i18next";
import {
  clearFeishuNotificationCredentials,
  getFeishuNotificationConfig,
  saveFeishuNotificationCredentials,
  sendFeishuNotification,
  type FeishuCredentialStatus,
} from "@/lib/api";
import { playNotificationSound, SOUND_OPTIONS } from "@/lib/sounds";
import {
  useAppStore,
  type FeishuNotificationEvent,
  type NotificationEvent,
  type NotificationSoundType,
} from "@/store";
import { NotificationDiagnostics } from "./NotificationDiagnostics";
import { SettingsPageHeader } from "./SettingsPageHeader";

function NotificationSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-6">
      <div
        className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-widest"
        style={{ color: "var(--cs-text-tertiary)" }}
      >
        {title}
      </div>
      <div
        className="app-glass-card overflow-hidden rounded-xl"
        style={{
          background: "var(--cs-bg-card)",
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function NotificationRow({
  label,
  desc,
  children,
}: {
  label: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-stretch gap-3 px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
      <div className="min-w-0 flex-1 xl:mr-4">
        <div className="text-sm" style={{ color: "var(--cs-text-primary)" }}>{label}</div>
        {desc && (
          <div className="mt-0.5 text-[11px]" style={{ color: "var(--cs-text-tertiary)" }}>
            {desc}
          </div>
        )}
      </div>
      <div className="flex shrink-0 justify-end">{children}</div>
    </div>
  );
}

export function NotificationsPage() {
  const { t } = useTranslation();
  const notificationEnabled = useAppStore((state) => state.notificationEnabled);
  const soundEnabled = useAppStore((state) => state.notificationSoundEnabled);
  const soundMap = useAppStore((state) => state.notificationSoundMap);
  const notificationThresholdMs = useAppStore((state) => state.notificationThresholdMs);
  const feishuEnabled = useAppStore((state) => state.feishuNotificationEnabled);
  const feishuThresholdMs = useAppStore((state) => state.feishuNotificationThresholdMs);
  const feishuEvents = useAppStore((state) => state.feishuNotificationEvents);
  const setNotificationEnabled = useAppStore((state) => state.setNotificationEnabled);
  const setSoundEnabled = useAppStore((state) => state.setNotificationSoundEnabled);
  const setSoundMap = useAppStore((state) => state.setNotificationSoundMap);
  const setNotificationThreshold = useAppStore((state) => state.setNotificationThreshold);
  const setFeishuEnabled = useAppStore((state) => state.setFeishuNotificationEnabled);
  const setFeishuThreshold = useAppStore((state) => state.setFeishuNotificationThreshold);
  const setFeishuEvent = useAppStore((state) => state.setFeishuNotificationEvent);
  const [credentialStatus, setCredentialStatus] = useState<FeishuCredentialStatus | null>(null);
  const [credentialLoading, setCredentialLoading] = useState(true);
  const [credentialSaving, setCredentialSaving] = useState(false);
  const [testingFeishu, setTestingFeishu] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [signingSecretTouched, setSigningSecretTouched] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCredentialLoading(true);
    getFeishuNotificationConfig()
      .then((status) => {
        if (!cancelled) setCredentialStatus(status);
      })
      .catch((error) => {
        if (!cancelled) {
          message.error(t("settings.notifications.feishu.loadFailed", { error: String(error) }));
        }
      })
      .finally(() => {
        if (!cancelled) setCredentialLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const systemThresholdOptions = [
    { label: t("settings.notificationThreshold.immediate"), value: 0 },
    { label: t("settings.notificationThreshold.sec5"), value: 5000 },
    { label: t("settings.notificationThreshold.sec10"), value: 10000 },
    { label: t("settings.notificationThreshold.sec30"), value: 30000 },
    { label: t("settings.notificationThreshold.min1"), value: 60000 },
  ];
  const feishuThresholdOptions = [
    { label: t("settings.notificationThreshold.min1"), value: 60000 },
    { label: t("settings.notifications.threshold.min5"), value: 300000 },
    { label: t("settings.notifications.threshold.min10"), value: 600000 },
    { label: t("settings.notifications.threshold.min30"), value: 1800000 },
    { label: t("settings.notifications.threshold.hour1"), value: 3600000 },
  ];
  const soundOptions = SOUND_OPTIONS.map((option) => ({
    value: option.value as NotificationSoundType,
    label: t(option.labelKey),
  }));
  const soundEntries: { event: NotificationEvent; label: string }[] = [
    { event: "taskComplete", label: t("sounds.taskComplete") },
    { event: "error", label: t("sounds.error") },
    { event: "waiting", label: t("sounds.waitingEvent") },
  ];
  const feishuEventEntries: { event: FeishuNotificationEvent; label: string; desc: string }[] = [
    {
      event: "completed",
      label: t("settings.notifications.events.completed"),
      desc: t("settings.notifications.events.completedDesc"),
    },
    {
      event: "error",
      label: t("settings.notifications.events.error"),
      desc: t("settings.notifications.events.errorDesc"),
    },
    {
      event: "waiting",
      label: t("settings.notifications.events.waiting"),
      desc: t("settings.notifications.events.waitingDesc"),
    },
    {
      event: "permission",
      label: t("settings.notifications.events.permission"),
      desc: t("settings.notifications.events.permissionDesc"),
    },
  ];

  async function saveCredentials() {
    if (!webhookUrl.trim() || credentialSaving) return;
    setCredentialSaving(true);
    try {
      const status = await saveFeishuNotificationCredentials(
        webhookUrl.trim(),
        signingSecretTouched ? signingSecret : null
      );
      setCredentialStatus(status);
      setWebhookUrl("");
      setSigningSecret("");
      setSigningSecretTouched(false);
      message.success(t("settings.notifications.feishu.saved"));
    } catch (error) {
      message.error(t("settings.notifications.feishu.saveFailed", { error: String(error) }));
    } finally {
      setCredentialSaving(false);
    }
  }

  async function clearCredentials() {
    try {
      const status = await clearFeishuNotificationCredentials();
      setCredentialStatus(status);
      setFeishuEnabled(false);
      setWebhookUrl("");
      setSigningSecret("");
      setSigningSecretTouched(false);
      message.success(t("settings.notifications.feishu.cleared"));
    } catch (error) {
      message.error(t("settings.notifications.feishu.clearFailed", { error: String(error) }));
    }
  }

  async function testFeishu() {
    if (!credentialStatus?.configured || testingFeishu) return;
    setTestingFeishu(true);
    try {
      await sendFeishuNotification({
        eventType: "test",
        title: t("settings.notifications.feishu.testCardTitle"),
        fields: [
          {
            label: t("settings.notifications.feishu.testCardChannel"),
            value: t("settings.notifications.feishu.channelName"),
          },
          {
            label: t("settings.notifications.feishu.testCardStatus"),
            value: t("settings.notifications.feishu.testCardSuccess"),
          },
        ],
      });
      message.success(t("settings.notifications.feishu.testSent"));
    } catch (error) {
      message.error(t("settings.notifications.feishu.testFailed", { error: String(error) }));
    } finally {
      setTestingFeishu(false);
    }
  }

  function changeFeishuEnabled(enabled: boolean) {
    if (enabled && !credentialStatus?.configured) {
      message.warning(t("settings.notifications.feishu.configureFirst"));
      return;
    }
    setFeishuEnabled(enabled);
  }

  return (
    <>
      <SettingsPageHeader
        title={t("settings.menu.notifications")}
        description={t("settings.notifications.headerDesc")}
      />

      <NotificationSection title={t("settings.notifications.channels")}>
        <NotificationRow
          label={t("settings.general.systemNotification")}
          desc={t("settings.general.systemNotificationDesc")}
        >
          <Switch checked={notificationEnabled} onChange={setNotificationEnabled} />
        </NotificationRow>
        <NotificationRow
          label={t("settings.notifications.feishu.channelName")}
          desc={t("settings.notifications.feishu.channelDesc")}
        >
          <div className="flex items-center gap-3">
            {credentialLoading ? (
              <Spin size="small" />
            ) : (
              <Tag color={credentialStatus?.configured ? "success" : "default"}>
                {t(
                  credentialStatus?.configured
                    ? "settings.notifications.feishu.configured"
                    : "settings.notifications.feishu.notConfigured"
                )}
              </Tag>
            )}
            <Switch
              checked={feishuEnabled}
              disabled={credentialLoading}
              onChange={changeFeishuEnabled}
            />
          </div>
        </NotificationRow>
      </NotificationSection>

      <NotificationSection title={t("settings.notifications.triggerPolicy")}>
        <NotificationRow
          label={t("settings.notifications.systemThreshold")}
          desc={t("settings.general.completionThresholdDesc")}
        >
          <Select
            size="small"
            value={notificationThresholdMs}
            options={systemThresholdOptions}
            onChange={setNotificationThreshold}
            style={{ width: 140 }}
          />
        </NotificationRow>
        <NotificationRow
          label={t("settings.notifications.feishuThreshold")}
          desc={t("settings.notifications.feishuThresholdDesc")}
        >
          <Select
            size="small"
            value={feishuThresholdMs}
            options={feishuThresholdOptions}
            onChange={setFeishuThreshold}
            style={{ width: 140 }}
          />
        </NotificationRow>
        {feishuEventEntries.map(({ event, label, desc }) => (
          <NotificationRow key={event} label={label} desc={desc}>
            <Switch
              checked={feishuEvents[event]}
              onChange={(enabled) => setFeishuEvent(event, enabled)}
            />
          </NotificationRow>
        ))}
      </NotificationSection>

      <NotificationSection title={t("settings.notifications.feishu.configuration")}>
        <div className="space-y-4 px-4 py-4">
          <div
            className="rounded-lg px-3 py-2 text-[11px] leading-5"
            style={{ background: "var(--cs-bg-hover)", color: "var(--cs-text-secondary)" }}
          >
            {t("settings.notifications.feishu.securityHint")}
          </div>
          {credentialStatus?.configured && (
            <div className="flex items-center justify-between gap-3 text-xs">
              <span style={{ color: "var(--cs-text-tertiary)" }}>
                {t("settings.notifications.feishu.currentWebhook")}
              </span>
              <span className="font-mono" style={{ color: "var(--cs-text-primary)" }}>
                {credentialStatus.webhookHint}
              </span>
            </div>
          )}
          <div>
            <div className="mb-1.5 text-xs" style={{ color: "var(--cs-text-secondary)" }}>
              {t("settings.notifications.feishu.webhook")}
            </div>
            <Input.Password
              value={webhookUrl}
              autoComplete="off"
              placeholder={t("settings.notifications.feishu.webhookPlaceholder")}
              onChange={(event) => setWebhookUrl(event.target.value)}
            />
          </div>
          <div>
            <div className="mb-1.5 text-xs" style={{ color: "var(--cs-text-secondary)" }}>
              {t("settings.notifications.feishu.signingSecret")}
            </div>
            <Input.Password
              value={signingSecret}
              autoComplete="new-password"
              placeholder={t(
                credentialStatus?.signingSecretConfigured
                  ? "settings.notifications.feishu.signingSecretKeepPlaceholder"
                  : "settings.notifications.feishu.signingSecretPlaceholder"
              )}
              onChange={(event) => {
                setSigningSecret(event.target.value);
                setSigningSecretTouched(true);
              }}
            />
          </div>
          {!credentialStatus?.secureStorageAvailable && !credentialLoading && (
            <div className="text-xs" style={{ color: "#d99b2b" }}>
              {t("settings.notifications.feishu.secureStorageUnavailable")}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Button
                type="primary"
                loading={credentialSaving}
                disabled={!webhookUrl.trim() || !credentialStatus?.secureStorageAvailable}
                onClick={() => void saveCredentials()}
              >
                {t("common.save")}
              </Button>
              <Button
                icon={<NotificationOutlined />}
                loading={testingFeishu}
                disabled={!credentialStatus?.configured}
                onClick={() => void testFeishu()}
              >
                {t("settings.notifications.feishu.sendTest")}
              </Button>
            </div>
            {credentialStatus?.configured && (
              <Popconfirm
                title={t("settings.notifications.feishu.clearConfirm")}
                onConfirm={() => void clearCredentials()}
              >
                <Button danger>{t("settings.notifications.feishu.clear")}</Button>
              </Popconfirm>
            )}
          </div>
        </div>
      </NotificationSection>

      <NotificationSection title={t("settings.general.sound")}>
        <NotificationRow label={t("settings.general.sound")} desc={t("settings.general.soundDesc")}>
          <Switch checked={soundEnabled} onChange={setSoundEnabled} />
        </NotificationRow>
        {soundEnabled &&
          soundEntries.map(({ event, label }, index) => (
            <div
              key={event}
              className="flex items-center px-4 py-3"
              style={{ borderTop: index === 0 ? "1px solid var(--cs-border-card)" : undefined }}
            >
              <div className="mr-4 flex min-w-0 flex-1 items-center gap-2">
                <SoundOutlined className="text-xs" style={{ color: "var(--cs-primary)" }} />
                <span className="text-sm" style={{ color: "var(--cs-text-primary)" }}>
                  {label}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  size="small"
                  value={soundMap[event]}
                  options={soundOptions}
                  onChange={(value) => setSoundMap(event, value)}
                  showSearch
                  optionFilterProp="label"
                  style={{ width: 220 }}
                />
                <Button
                  type="text"
                  size="small"
                  icon={<PlayCircleOutlined />}
                  title={t("settings.general.previewSound")}
                  onClick={() => playNotificationSound(soundMap[event])}
                />
              </div>
            </div>
          ))}
      </NotificationSection>

      <NotificationSection title={t("sidebar.attentionDiagnostics.title")}>
        <NotificationDiagnostics />
      </NotificationSection>
    </>
  );
}