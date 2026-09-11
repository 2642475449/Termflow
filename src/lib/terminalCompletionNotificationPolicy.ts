import type { NotificationSuppressionReason } from "./attentionDiagnostics";

type TerminalCompletionIngestSuppressionReason = Extract<
  NotificationSuppressionReason,
  "notifications-disabled" | "completion-duration-unavailable" | "below-duration-threshold"
>;

export function getTerminalCompletionIngestSuppressionReason({
  enabled,
  durationMs,
  thresholdMs,
}: {
  enabled: boolean;
  durationMs: number | null;
  thresholdMs: number;
}): TerminalCompletionIngestSuppressionReason | null {
  if (!enabled) return "notifications-disabled";
  if (durationMs === null) return "completion-duration-unavailable";
  if (durationMs < thresholdMs) return "below-duration-threshold";
  return null;
}

export function getTerminalCompletionDeliverySuppressionReason({
  externalNotificationsEnabled,
  targetObserved,
  windowForeground,
}: {
  externalNotificationsEnabled: boolean;
  targetObserved: boolean;
  windowForeground: boolean;
}): Extract<NotificationSuppressionReason, "notifications-disabled" | "foreground-session" | "foreground-window"> | null {
  if (targetObserved) return "foreground-session";
  if (!externalNotificationsEnabled) return "notifications-disabled";
  if (windowForeground) return "foreground-window";
  return null;
}
