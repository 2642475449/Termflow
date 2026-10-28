import { expect, test } from "vitest";
import { hasUsageData, usageFailureDelay, usageMonitorDelay, usageViewKey } from "./agentUsage";
import type { AntigravityUsage, CodexRateLimits, QoderUsage } from "@/types";

const codex: CodexRateLimits = {
  session: null, weekly: null, updatedAt: 1, status: "ok", error: null, accountId: null, accountLabel: null,
};

test("absence is distinct from a measured zero or a retained failed snapshot", () => {
  expect(hasUsageData(null)).toBe(false);
  expect(hasUsageData(codex)).toBe(false);
  expect(hasUsageData({ ...codex, status: "error", weekly: {
    usedPercent: 100, windowMinutes: 10080, resetsAt: null, resetDescription: null,
  } })).toBe(true);
  const antigravity: AntigravityUsage = { windows: [], updatedAt: 1, status: "ok", error: null };
  expect(hasUsageData(antigravity)).toBe(false);
  expect(hasUsageData({ ...antigravity, windows: [{
    id: "weekly", scope: "Gemini", window: "weekly", remainingPercent: 0, resetDescription: null,
  }] })).toBe(true);
  const qoder: QoderUsage = {
    userType: null, totalUsagePercentage: 0, expiresAt: null, userQuota: null, addOnQuota: null,
    orgResourcePackage: null, isQuotaExceeded: null, sessionCredits: null, updatedAt: 1,
    status: "ok", error: null, accountLabel: null,
  };
  expect(hasUsageData(qoder)).toBe(true);
  expect(hasUsageData({ ...qoder, totalUsagePercentage: null })).toBe(false);
});

test("all transport failures use the shared capped backoff sequence", () => {
  expect([1, 2, 3, 4, 5, 6].map(usageFailureDelay)).toEqual([180000, 360000, 720000, 1440000, 1800000, 1800000]);
  expect(usageFailureDelay(1000)).toBe(1800000);
});

test("scheduled checks honor transport backoff and discover source changes without rapid polling", () => {
  expect(usageMonitorDelay(null, 1000, 361000)).toBe(360000);
  expect(usageMonitorDelay({ ...codex, nextRetryAt: 6000 }, 1000)).toBe(5000);
  expect(usageMonitorDelay({ ...codex, nextRetryAt: null }, 1000)).toBe(180000);
  expect(usageMonitorDelay({ ...codex, nextRetryAt: 0 }, 1000)).toBe(1000);
});

test("Claude sessions are isolated while account-level provider views are shared across tabs", () => {
  expect(usageViewKey("claude", "one")).not.toBe(usageViewKey("claude", "two"));
  expect(usageViewKey("codex", "one")).toBe(usageViewKey("codex", "two"));
});
