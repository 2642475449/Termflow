export const REMOTE_NOTIFICATION_PROVIDERS = [
  { id: "feishu", supported: true },
  { id: "dingtalk", supported: false },
  { id: "wechat", supported: false },
  { id: "qq", supported: false },
  { id: "telegram", supported: false },
] as const;

export type RemoteNotificationProvider = (typeof REMOTE_NOTIFICATION_PROVIDERS)[number]["id"];

export const DEFAULT_REMOTE_NOTIFICATION_EVENTS = {
  completed: true,
  error: true,
  waiting: true,
  permission: true,
} as const;

export const DEFAULT_REMOTE_NOTIFICATION_CHANNEL = {
  enabled: false,
  thresholdMs: 300000,
  events: DEFAULT_REMOTE_NOTIFICATION_EVENTS,
} as const;

export function createDefaultRemoteNotificationChannels() {
  return Object.fromEntries(
    REMOTE_NOTIFICATION_PROVIDERS.map(({ id }) => [
      id,
      {
        ...DEFAULT_REMOTE_NOTIFICATION_CHANNEL,
        events: { ...DEFAULT_REMOTE_NOTIFICATION_EVENTS },
      },
    ]),
  ) as Record<RemoteNotificationProvider, {
    enabled: boolean;
    thresholdMs: number;
    events: Record<keyof typeof DEFAULT_REMOTE_NOTIFICATION_EVENTS, boolean>;
  }>;
}
