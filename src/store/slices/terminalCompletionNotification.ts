export const DEFAULT_TERMINAL_COMPLETION_NOTIFICATION_THRESHOLD_MS = 30_000;
export const MIN_TERMINAL_COMPLETION_NOTIFICATION_THRESHOLD_MS = 10_000;
export const MAX_TERMINAL_COMPLETION_NOTIFICATION_THRESHOLD_MS = 600_000;

export interface TerminalCompletionNotificationSlice {
  terminalCompletionNotificationsEnabled: boolean;
  terminalCompletionNotificationThresholdMs: number;
  setTerminalCompletionNotificationsEnabled: (enabled: boolean) => void;
  setTerminalCompletionNotificationThreshold: (thresholdMs: number) => void;
}

export function normalizeTerminalCompletionNotificationThreshold(
  thresholdMs: number | null | undefined,
): number {
  if (typeof thresholdMs !== "number" || !Number.isFinite(thresholdMs)) {
    return DEFAULT_TERMINAL_COMPLETION_NOTIFICATION_THRESHOLD_MS;
  }
  return Math.min(
    MAX_TERMINAL_COMPLETION_NOTIFICATION_THRESHOLD_MS,
    Math.max(
      MIN_TERMINAL_COMPLETION_NOTIFICATION_THRESHOLD_MS,
      Math.round(thresholdMs),
    ),
  );
}

export function createTerminalCompletionNotificationSlice(
  set: (partial: Partial<TerminalCompletionNotificationSlice>) => void,
): TerminalCompletionNotificationSlice {
  return {
    terminalCompletionNotificationsEnabled: true,
    terminalCompletionNotificationThresholdMs: DEFAULT_TERMINAL_COMPLETION_NOTIFICATION_THRESHOLD_MS,
    setTerminalCompletionNotificationsEnabled: (enabled) =>
      set({ terminalCompletionNotificationsEnabled: enabled }),
    setTerminalCompletionNotificationThreshold: (thresholdMs) =>
      set({
        terminalCompletionNotificationThresholdMs:
          normalizeTerminalCompletionNotificationThreshold(thresholdMs),
      }),
  };
}
