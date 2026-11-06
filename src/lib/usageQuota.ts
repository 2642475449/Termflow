import type { TFunction } from "i18next";
import type { ClaudeRateLimits, CodexRateLimits, UsageQuotaDetails, UsageQuotaWindow } from "@/types";

export function quotaWindows(value: (UsageQuotaDetails & Partial<Pick<CodexRateLimits, "session" | "weekly">>) | null): UsageQuotaWindow[] {
  if (!value) return [];
  // An explicitly empty list is authoritative; old windows must not reappear after a reset.
  if (value.quotaWindows) return value.quotaWindows.filter((w) => Number.isFinite(w.usedPercent));
  return [value.session, value.weekly].flatMap((w, i) => w && Number.isFinite(w.usedPercent)
    ? [{ ...w, id: String(i), bucketId: "default", bucketName: null, label: null }] : []);
}

export function remainingQuota(window: { usedPercent: number }): number {
  return Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)));
}

export function tightestQuota(windows: UsageQuotaWindow[]): UsageQuotaWindow | null {
  return windows.reduce<UsageQuotaWindow | null>((best, window) => !best || window.usedPercent > best.usedPercent ? window : best, null);
}

export function quotaWindowLabel(window: UsageQuotaWindow, t: TFunction): string {
  const key = "statusBar.quota";
  let label: string;
  if (window.label) {
    const known = ["monthly", "monthlySpend", "dailySpend", "weeklySpend", "spendLimit", "extraUsage"];
    label = known.includes(window.label) ? t(`${key}.${window.label}`) : window.label;
  } else {
    const minutes = window.windowMinutes;
    label = !Number.isFinite(minutes) || minutes <= 0 ? t(`${key}.unknownWindow`)
      : minutes === 10080 ? t(`${key}.weekly`)
      : minutes % 1440 === 0 ? t(`${key}.days`, { value: minutes / 1440 })
      : minutes % 60 === 0 ? t(`${key}.hours`, { value: minutes / 60 })
      : t(`${key}.minutes`, { value: minutes });
  }
  return window.bucketName ? `${window.bucketName} · ${label}` : label;
}

export function hasQuotaData(value: (UsageQuotaDetails & Partial<Pick<CodexRateLimits, "session" | "weekly" | "rateLimitResetCredits">>) | null): boolean {
  return quotaWindows(value).length > 0 || Boolean(value?.balances?.length || value?.limitReached || value?.rateLimitResetCredits);
}

export function legacyQuotaDetails(value: ClaudeRateLimits | CodexRateLimits | null): UsageQuotaDetails {
  return { ...value, quotaWindows: quotaWindows(value) };
}
