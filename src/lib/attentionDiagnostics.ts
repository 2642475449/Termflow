import type { AiAgentId } from "@/types";

export type EventIngestOutcome = "accepted" | "duplicate" | "stale";
export type NotificationChannel = "system" | "feishu";

export type NotificationSuppressionReason =
  | "notifications-disabled"
  | "foreground-session"
  | "completion-duration-unavailable"
  | "below-duration-threshold"
  | "permission-denied";

export interface AgentHookDiagnostic {
  agentId: AiAgentId;
  configured: boolean;
  configPath?: string;
  detail?: string;
  checkedAt: number;
  error?: string;
}

export interface AttentionEventDiagnostic {
  eventId: string;
  sessionId: string;
  eventType: string;
  source: string;
  revision?: number | null;
  createdAt: number;
  receivedAt: number;
  outcome: EventIngestOutcome;
  requiresAttention: boolean;
  foreground: boolean;
}

export interface NotificationDeliveryDiagnostic {
  channel?: NotificationChannel;
  eventId: string;
  eventType: string;
  status: "sent" | "suppressed" | "failed";
  updatedAt: number;
  reason?: NotificationSuppressionReason;
  error?: string;
  test?: boolean;
}

export interface AttentionDiagnostics {
  hooks: Partial<Record<AiAgentId, AgentHookDiagnostic>>;
  lastEvent?: AttentionEventDiagnostic;
  lastNotification?: NotificationDeliveryDiagnostic;
  lastNotifications?: Partial<Record<NotificationChannel, NotificationDeliveryDiagnostic>>;
}

interface NotificationPolicyInput {
  enabled: boolean;
  foreground: boolean;
  suppressWhenForeground?: boolean;
  eventType: string;
  durationMs: number | null;
  completionThresholdMs: number;
}

export function getNotificationSuppressionReason({
  enabled,
  foreground,
  suppressWhenForeground = true,
  eventType,
  durationMs,
  completionThresholdMs,
}: NotificationPolicyInput): NotificationSuppressionReason | null {
  if (!enabled) return "notifications-disabled";
  if (suppressWhenForeground && foreground) return "foreground-session";
  if (eventType === "assistant_complete") {
    if (durationMs === null) {
      return "completion-duration-unavailable";
    }
    if (durationMs !== null && durationMs < completionThresholdMs) {
      return "below-duration-threshold";
    }
  }
  return null;
}
