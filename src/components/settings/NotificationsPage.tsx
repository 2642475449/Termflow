import { useEffect, useState, type ReactNode } from "react";
import { NotificationOutlined, PlayCircleOutlined, SoundOutlined } from "@ant-design/icons";
import { Button, Input, message, Modal, Popconfirm, Select, Spin, Switch, Tag } from "antd";
import { useTranslation } from "react-i18next";
import {
  clearRemoteNotificationCredentials,
  getRemoteNotificationConfig,
  saveRemoteNotificationCredentials,
  sendRemoteNotification,
  type RemoteNotificationCredentialStatus,
} from "@/lib/api";
import {
  REMOTE_NOTIFICATION_PROVIDERS,
  type RemoteNotificationProvider,
} from "@/lib/remoteNotifications";
import { playNotificationSound, SOUND_OPTIONS } from "@/lib/sounds";
import {
  useAppStore,
  type RemoteNotificationEvent,
  type NotificationEvent,
  type NotificationSoundType,
} from "@/store";
import { SettingsPageHeader } from "./SettingsPageHeader";
import { SettingsField, SettingsSection as NotificationSection } from "./SettingsSection";
import { SettingRow } from "./SettingRow";
import feishuIcon from "@/assets/remote-notification-icons/feishu.svg";
import dingtalkIcon from "@/assets/remote-notification-icons/dingtalk.svg";
import wechatIcon from "@/assets/remote-notification-icons/wechat.svg";
import qqIcon from "@/assets/remote-notification-icons/qq.svg";
import telegramIcon from "@/assets/remote-notification-icons/telegram.svg";

const REMOTE_NOTIFICATION_PROVIDER_ICONS: Record<RemoteNotificationProvider, string> = {
  feishu: feishuIcon,
  dingtalk: dingtalkIcon,
  wechat: wechatIcon,
  qq: qqIcon,
  telegram: telegramIcon,
};

function RemoteNotificationProviderIcon({
  provider,
  muted = false,
}: {
  provider: RemoteNotificationProvider;
  muted?: boolean;
}) {
  return (
    <img
      src={REMOTE_NOTIFICATION_PROVIDER_ICONS[provider]}
      alt=""
      aria-hidden="true"
      className={`h-4 w-4 shrink-0 object-contain ${muted ? "opacity-45" : ""}`}
    />
  );
}

function NotificationRow({
  label,
  status,
  children,
}: {
  label: string;
  status?: string;
  children: ReactNode;
}) {
  return <SettingRow label={label} description={status}>{children}</SettingRow>;
}

export function NotificationsPage() {
  const { t } = useTranslation();
  const notificationEnabled = useAppStore((state) => state.notificationEnabled);
  const soundEnabled = useAppStore((state) => state.notificationSoundEnabled);
  const soundMap = useAppStore((state) => state.notificationSoundMap);
  const notificationThresholdMs = useAppStore((state) => state.notificationThresholdMs);
  const terminalCompletionNotificationsEnabled = useAppStore(
    (state) => state.terminalCompletionNotificationsEnabled,
  );
  const terminalCompletionNotificationThresholdMs = useAppStore(
    (state) => state.terminalCompletionNotificationThresholdMs,
  );
  const terminalCompletionIntegration = useAppStore((state) =>
    state.activeSessionId
      ? state.terminalCompletionIntegrationBySession[state.activeSessionId] ?? null
      : null,
  );
  const remoteNotificationChannels = useAppStore((state) => state.remoteNotificationChannels);
  const setNotificationEnabled = useAppStore((state) => state.setNotificationEnabled);
  const setSoundEnabled = useAppStore((state) => state.setNotificationSoundEnabled);
  const setSoundMap = useAppStore((state) => state.setNotificationSoundMap);
  const setNotificationThreshold = useAppStore((state) => state.setNotificationThreshold);
  const setTerminalCompletionNotificationsEnabled = useAppStore(
    (state) => state.setTerminalCompletionNotificationsEnabled,
  );
  const setTerminalCompletionNotificationThreshold = useAppStore(
    (state) => state.setTerminalCompletionNotificationThreshold,
  );
  const setRemoteEnabled = useAppStore((state) => state.setRemoteNotificationEnabled);
  const setRemoteThreshold = useAppStore((state) => state.setRemoteNotificationThreshold);
  const setRemoteEvent = useAppStore((state) => state.setRemoteNotificationEvent);
  const [selectedProvider, setSelectedProvider] = useState<RemoteNotificationProvider>("feishu");
  const [credentialStatus, setCredentialStatus] = useState<RemoteNotificationCredentialStatus | null>(null);
  const [credentialLoading, setCredentialLoading] = useState(true);
  const [credentialSaving, setCredentialSaving] = useState(false);
  const [testingRemote, setTestingRemote] = useState(false);
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [enableOnSave, setEnableOnSave] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [signingSecretTouched, setSigningSecretTouched] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCredentialLoading(true);
    setCredentialStatus(null);
    getRemoteNotificationConfig(selectedProvider)
      .then((status) => {
        if (!cancelled) setCredentialStatus(status);
      })
      .catch((error) => {
        if (!cancelled) {
          message.error(t("settings.notifications.remote.loadFailed", { error: String(error) }));
        }
      })
      .finally(() => {
        if (!cancelled) setCredentialLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProvider, t]);

  const systemThresholdOptions = [
    { label: t("settings.notificationThreshold.immediate"), value: 0 },
    { label: t("settings.notificationThreshold.sec5"), value: 5000 },
    { label: t("settings.notificationThreshold.sec10"), value: 10000 },
    { label: t("settings.notificationThreshold.sec30"), value: 30000 },
    { label: t("settings.notificationThreshold.min1"), value: 60000 },
  ];
  const remoteThresholdOptions = [
    { label: t("settings.notificationThreshold.min1"), value: 60000 },
    { label: t("settings.notifications.threshold.min5"), value: 300000 },
    { label: t("settings.notifications.threshold.min10"), value: 600000 },
    { label: t("settings.notifications.threshold.min30"), value: 1800000 },
    { label: t("settings.notifications.threshold.hour1"), value: 3600000 },
  ];
  const terminalCompletionThresholdOptions = [
    { label: t("settings.notificationThreshold.sec10"), value: 10_000 },
    { label: t("settings.notificationThreshold.sec30"), value: 30_000 },
    { label: t("settings.notificationThreshold.min1"), value: 60_000 },
    { label: t("settings.notifications.threshold.min5"), value: 300_000 },
    { label: t("settings.notifications.threshold.min10"), value: 600_000 },
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
  const remoteEventEntries: { event: RemoteNotificationEvent; label: string; desc: string }[] = [
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

  function openConfigModal(shouldEnableOnSave = false) {
    setWebhookUrl("");
    setSigningSecret("");
    setSigningSecretTouched(false);
    setEnableOnSave(shouldEnableOnSave);
    setConfigModalOpen(true);
  }

  function closeConfigModal() {
    if (credentialSaving) return;
    setConfigModalOpen(false);
    setEnableOnSave(false);
    setWebhookUrl("");
    setSigningSecret("");
    setSigningSecretTouched(false);
  }

  async function saveCredentials() {
    if (!webhookUrl.trim() || credentialSaving) return;
    setCredentialSaving(true);
    try {
      const status = await saveRemoteNotificationCredentials(
        selectedProvider,
        webhookUrl.trim(),
        signingSecretTouched ? signingSecret : null
      );
      setCredentialStatus(status);
      if (enableOnSave) {
        setRemoteEnabled(selectedProvider, true);
      }
      setConfigModalOpen(false);
      setEnableOnSave(false);
      setWebhookUrl("");
      setSigningSecret("");
      setSigningSecretTouched(false);
      message.success(t("settings.notifications.remote.saved"));
    } catch (error) {
      message.error(t("settings.notifications.remote.saveFailed", { error: String(error) }));
    } finally {
      setCredentialSaving(false);
    }
  }

  async function clearCredentials() {
    try {
      const status = await clearRemoteNotificationCredentials(selectedProvider);
      setCredentialStatus(status);
      setRemoteEnabled(selectedProvider, false);
      setWebhookUrl("");
      setSigningSecret("");
      setSigningSecretTouched(false);
      message.success(t("settings.notifications.remote.cleared"));
    } catch (error) {
      message.error(t("settings.notifications.remote.clearFailed", { error: String(error) }));
    }
  }

  async function testRemoteNotification() {
    if (!credentialStatus?.configured || testingRemote) return;
    setTestingRemote(true);
    try {
      await sendRemoteNotification(selectedProvider, {
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
      message.success(t("settings.notifications.remote.testSent"));
    } catch (error) {
      message.error(t("settings.notifications.remote.testFailed", { error: String(error) }));
    } finally {
      setTestingRemote(false);
    }
  }

  function changeRemoteEnabled(enabled: boolean) {
    if (enabled && !credentialStatus?.configured) {
      openConfigModal(true);
      return;
    }
    setRemoteEnabled(selectedProvider, enabled);
  }

  const selectedChannel = remoteNotificationChannels[selectedProvider];
  const terminalCompletionStatusKey = terminalCompletionIntegration
    ? `settings.notifications.terminalCompletion.status.${terminalCompletionIntegration.status}`
    : "settings.notifications.terminalCompletion.status.noActiveTerminal";
  const terminalCompletionStatusDescriptionKey = !terminalCompletionIntegration
    ? "settings.notifications.terminalCompletion.noActiveTerminalDesc"
    : terminalCompletionIntegration.reason
      ? `settings.notifications.terminalCompletion.statusReason.${terminalCompletionIntegration.reason}`
      : terminalCompletionIntegration.status === "available"
        ? "settings.notifications.terminalCompletion.statusReason.available"
        : "settings.notifications.terminalCompletion.statusReason.pending";
  const terminalCompletionStatusColor =
    terminalCompletionIntegration?.status === "available"
      ? "success"
      : terminalCompletionIntegration?.status === "pending"
        ? "processing"
        : "default";

  return (
    <>
      <SettingsPageHeader
        title={t("settings.menu.notifications")}
      />

      <NotificationSection title={t("settings.notifications.channels")}>
        <NotificationRow
          label={t("settings.general.systemNotification")}
        >
          <Switch checked={notificationEnabled} onChange={setNotificationEnabled} />
        </NotificationRow>
        <NotificationRow
          label={t("settings.notifications.remote.channelName")}
        >
          <div className="flex items-center gap-3">
            {credentialLoading ? (
              <Spin size="small" />
            ) : (
              <Tag color={credentialStatus?.configured ? "success" : "default"}>
                {t(
                  credentialStatus?.configured
                    ? "settings.notifications.remote.configured"
                    : "settings.notifications.remote.notConfigured"
                )}
              </Tag>
            )}
            {!selectedChannel.enabled && !credentialLoading && (
              <Button
                size="small"
                onClick={() => openConfigModal(!credentialStatus?.configured)}
              >
                {t(
                  credentialStatus?.configured
                    ? "settings.notifications.remote.editConfig"
                    : "settings.notifications.remote.configure"
                )}
              </Button>
            )}
            <Switch
              checked={selectedChannel.enabled}
              disabled={credentialLoading}
              onChange={changeRemoteEnabled}
            />
          </div>
        </NotificationRow>
      </NotificationSection>

      <NotificationSection title={t("settings.notifications.triggerPolicy")}>
        <NotificationRow
          label={t("settings.notifications.systemThreshold")}
        >
          <Select
            size="small"
            className="w-[140px]"
            value={notificationThresholdMs}
            options={systemThresholdOptions}
            onChange={setNotificationThreshold}
          />
        </NotificationRow>
        {selectedChannel.enabled && (
          <>
            <NotificationRow
              label={t("settings.notifications.remoteThreshold")}
            >
              <Select
                size="small"
                className="w-[140px]"
                value={selectedChannel.thresholdMs}
                options={remoteThresholdOptions}
                onChange={(value) => setRemoteThreshold(selectedProvider, value)}
              />
            </NotificationRow>
            {remoteEventEntries.map(({ event, label }) => (
              <NotificationRow key={event} label={label}>
                <Switch
                  checked={selectedChannel.events[event]}
                  onChange={(enabled) => setRemoteEvent(selectedProvider, event, enabled)}
                />
              </NotificationRow>
            ))}
          </>
        )}
      </NotificationSection>

      <NotificationSection title={t("settings.notifications.terminalCompletion.section")}>
        <NotificationRow
          label={t("settings.notifications.terminalCompletion.enabled")}
        >
          <Switch
            checked={terminalCompletionNotificationsEnabled}
            onChange={setTerminalCompletionNotificationsEnabled}
          />
        </NotificationRow>
        {terminalCompletionNotificationsEnabled && (
          <NotificationRow
            label={t("settings.notifications.terminalCompletion.threshold")}
          >
            <Select
              size="small"
              className="w-[140px]"
              value={terminalCompletionNotificationThresholdMs}
              options={terminalCompletionThresholdOptions}
              onChange={setTerminalCompletionNotificationThreshold}
            />
          </NotificationRow>
        )}
        <NotificationRow
          label={t("settings.notifications.terminalCompletion.integrationStatus")}
          status={t(terminalCompletionStatusDescriptionKey)}
        >
          <Tag color={terminalCompletionStatusColor}>{t(terminalCompletionStatusKey)}</Tag>
        </NotificationRow>
      </NotificationSection>

      {selectedChannel.enabled && (
        <NotificationSection title={t("settings.notifications.remote.configuration")}>
          <NotificationRow label={t("settings.notifications.remote.provider")}>
            <Select
              size="small"
              className="w-[160px]"
              value={selectedProvider}
              options={REMOTE_NOTIFICATION_PROVIDERS.map(({ id, supported }) => ({
                value: id,
                disabled: !supported,
                label: (
                  <span className="flex items-center gap-2">
                    <RemoteNotificationProviderIcon provider={id} muted={!supported} />
                    <span>
                      {t(`settings.notifications.remote.providers.${id}`)}
                      {!supported && ` · ${t("settings.notifications.remote.comingSoon")}`}
                    </span>
                  </span>
                ),
              }))}
              onChange={setSelectedProvider}
            />
          </NotificationRow>
          <NotificationRow
            label={t("settings.notifications.feishu.webhook")}
            status={
              credentialStatus?.configured
                ? `${t("settings.notifications.feishu.currentWebhook")}：${credentialStatus.endpointHint}`
                : t("settings.notifications.remote.notConfigured")
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <Button size="small" onClick={() => openConfigModal()}>
                {t(
                  credentialStatus?.configured
                    ? "settings.notifications.remote.editConfig"
                    : "settings.notifications.remote.configure"
                )}
              </Button>
              <Button
                size="small"
                icon={<NotificationOutlined />}
                loading={testingRemote}
                disabled={!credentialStatus?.configured}
                onClick={() => void testRemoteNotification()}
              >
                {t("settings.notifications.remote.sendTest")}
              </Button>
              {credentialStatus?.configured && (
                <Popconfirm
                  title={t("settings.notifications.remote.clearConfirm")}
                  onConfirm={() => void clearCredentials()}
                >
                  <Button size="small" danger>
                    {t("settings.notifications.remote.clear")}
                  </Button>
                </Popconfirm>
              )}
            </div>
          </NotificationRow>
        </NotificationSection>
      )}

      <NotificationSection title={t("settings.general.sound")}>
        <NotificationRow label={t("settings.general.sound")}>
          <Switch checked={soundEnabled} onChange={setSoundEnabled} />
        </NotificationRow>
        {soundEnabled &&
          soundEntries.map(({ event, label }, index) => (
            <div
              key={event}
              className={`flex items-center px-4 py-3 ${
                index === 0 ? "border-t border-[var(--cs-border-card)]" : ""
              }`}
            >
              <div className="mr-4 flex min-w-0 flex-1 items-center gap-2">
                <SoundOutlined className="text-xs text-[var(--cs-primary)]" />
                <span className="text-sm text-[var(--cs-text-primary)]">
                  {label}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  size="small"
                  className="w-[220px]"
                  value={soundMap[event]}
                  options={soundOptions}
                  onChange={(value) => setSoundMap(event, value)}
                  showSearch
                  optionFilterProp="label"
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

      <Modal
        open={configModalOpen}
        title={t("settings.notifications.remote.modalTitle", {
          provider: t(`settings.notifications.remote.providers.${selectedProvider}`),
        })}
        okText={t("common.save")}
        cancelText={t("common.cancel", { defaultValue: "取消" })}
        onOk={() => void saveCredentials()}
        onCancel={closeConfigModal}
        confirmLoading={credentialSaving}
        closable={!credentialSaving}
        maskClosable={!credentialSaving}
        cancelButtonProps={{ disabled: credentialSaving }}
        okButtonProps={{
          disabled: !webhookUrl.trim() || !credentialStatus?.secureStorageAvailable,
        }}
        destroyOnHidden
        centered
        width={520}
      >
        <div className="space-y-4 pt-2">
          <div className="rounded-lg bg-[var(--cs-bg-hover)] px-3 py-2 text-xs leading-5 text-[var(--cs-text-secondary)]">
            {t("settings.notifications.feishu.securityHint")}
          </div>
          {credentialStatus?.configured && (
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-[var(--cs-text-tertiary)]">
                {t("settings.notifications.feishu.currentWebhook")}
              </span>
              <span className="font-mono text-[var(--cs-text-primary)]">
                {credentialStatus.endpointHint}
              </span>
            </div>
          )}
          <SettingsField
            htmlFor="remote-notification-webhook"
            label={t("settings.notifications.feishu.webhook")}
          >
            <Input.Password
              id="remote-notification-webhook"
              value={webhookUrl}
              autoComplete="off"
              placeholder={t("settings.notifications.feishu.webhookPlaceholder")}
              onChange={(event) => setWebhookUrl(event.target.value)}
            />
          </SettingsField>
          <SettingsField
            htmlFor="remote-notification-signing-secret"
            label={t("settings.notifications.feishu.signingSecret")}
          >
            <Input.Password
              id="remote-notification-signing-secret"
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
          </SettingsField>
          {!credentialStatus?.secureStorageAvailable && !credentialLoading && (
            <div className="app-settings-warning px-3 py-2 text-xs">
              {t("settings.notifications.feishu.secureStorageUnavailable")}
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
