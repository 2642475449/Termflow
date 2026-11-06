import { beforeAll, expect, test } from "vitest";
import { createInstance } from "i18next";
import en from "@/locales/en-US.json";
import zh from "@/locales/zh-CN.json";
import ja from "@/locales/ja-JP.json";
import { hasQuotaData, quotaWindowLabel, quotaWindows, remainingQuota, tightestQuota } from "./usageQuota";
import type { UsageQuotaWindow } from "@/types";

const i18n = createInstance();
beforeAll(async () => { await i18n.init({ lng: "en", resources: { en: { translation: en }, zh: { translation: zh }, ja: { translation: ja } } }); });
const window = (minutes: number, usedPercent = 0): UsageQuotaWindow => ({ id: String(minutes), label: null, bucketId: "codex", bucketName: null, windowMinutes: minutes, usedPercent, resetsAt: null, resetDescription: null });

test.each([[15, "15 minutes"], [300, "5 hours"], [1440, "1 days"], [10080, "Weekly"], [43200, "30 days"], [0, "Unknown period"]])("actual %s minute window is never mislabeled", (minutes, expected) => {
  expect(quotaWindowLabel(window(minutes as number), i18n.t)).toBe(expected);
});

test("missing duration is never inferred from a Free or Go plan", () => {
  for (const planType of ["free", "go", "plus", "pro"]) {
    const details = { planType, quotaWindows: [window(0)] };
    expect(quotaWindowLabel(quotaWindows(details)[0], i18n.t)).toBe("Unknown period");
  }
});

test("weekly exhaustion wins over an almost unused five-hour window", () => {
  const critical = tightestQuota([window(300, 10), window(10080, 100)]);
  expect(critical?.windowMinutes).toBe(10080);
  expect(remainingQuota(critical!)).toBe(0);
});

test("authoritative empty windows clear legacy data, balances and reset credits remain data", () => {
  const legacy = { session: window(300), weekly: null };
  expect(quotaWindows(legacy)).toHaveLength(1);
  expect(quotaWindows({ ...legacy, quotaWindows: [] })).toEqual([]);
  expect(hasQuotaData({ quotaWindows: [], balances: [{ bucketId: "codex", bucketName: null, balance: 0, unlimited: false, hasCredits: false }] })).toBe(true);
  expect(hasQuotaData({ quotaWindows: [], rateLimitResetCredits: { availableCount: 1 } })).toBe(true);
  expect(hasQuotaData({ quotaWindows: [] })).toBe(false);
});

test("monthly gateway budgets and model buckets keep their identities in every locale", () => {
  for (const locale of ["en", "zh", "ja"]) {
    const t = i18n.getFixedT(locale);
    const label = quotaWindowLabel({ ...window(0), label: "monthlySpend", bucketName: "Model A" }, t);
    expect(label).toContain("Model A");
    expect(label).not.toContain("statusBar.");
    expect(label).not.toContain("Unknown period");
  }
});
