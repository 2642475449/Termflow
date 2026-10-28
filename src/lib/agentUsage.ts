import type { AntigravityUsage, ClaudeRateLimits, CodexRateLimits, QoderUsage } from "@/types";

export interface UsageDataByAgent {
  codex: CodexRateLimits;
  claude: ClaudeRateLimits;
  qoder: QoderUsage;
  antigravity: AntigravityUsage;
}
export type UsageAgentId = keyof UsageDataByAgent;
export type AgentUsageSnapshot = UsageDataByAgent[UsageAgentId];
export const USAGE_REFRESH_INTERVAL_MS = 3 * 60 * 1000;

export function usageViewKey(agent: UsageAgentId, sessionId?: string): string {
  return agent === "claude" ? `${agent}:${sessionId ?? ""}` : agent;
}

export function usageFailureDelay(failures: number): number {
  return Math.min(USAGE_REFRESH_INTERVAL_MS * 2 ** Math.max(0, Math.min(failures - 1, 4)), 30 * 60 * 1000);
}

export function hasUsageData(value: AgentUsageSnapshot | null): boolean {
  if (!value) return false;
  if ("windows" in value) return value.windows.length > 0;
  if ("userQuota" in value) {
    return value.totalUsagePercentage != null || Boolean(value.userQuota || value.addOnQuota || value.orgResourcePackage);
  }
  return Boolean(value.session || value.weekly);
}

// 后端控制实际查询频率；定时检查仍允许发现新快照与凭据变化。
export function usageMonitorDelay(value: AgentUsageSnapshot | null, now: number, transportRetryAt = 0): number {
  if (transportRetryAt > now) return transportRetryAt - now;
  const retryAt = value?.nextRetryAt;
  return retryAt == null ? USAGE_REFRESH_INTERVAL_MS
    : Math.max(1_000, Math.min(USAGE_REFRESH_INTERVAL_MS, retryAt - now));
}
