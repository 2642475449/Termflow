import { expect, test } from "vitest";
import type { AgentUsageOverview } from "@/types";
import { addDays, buildOverviewMetrics, formatDateKey, getHeatmapGridStart } from "./usageMetrics";

function overview(): AgentUsageOverview {
  return {
    lastComputedDate: "2026-10-29",
    summary: {
      totalTokens: 570, totalMessages: 2, totalSessions: 2, activeDays: 2,
      totalDays: 29, peakDailyTokens: 310, longestSessionMs: 0,
      currentStreakDays: 1, longestStreakDays: 1, favoriteModel: "fixture", peakHour: 10,
      undatedTokens: 160, tokenDataIncomplete: true,
    },
    tokenBreakdown: {
      inputTokens: 200, outputTokens: 30, cacheReadTokens: 340,
      cacheCreationTokens: 0, reasoningOutputTokens: 0, otherTokens: 0, totalTokens: 570,
    },
    dailyActivity: [
      { date: "2026-10-01", sessionCount: 1, messageCount: 1 },
      { date: "2026-10-29", sessionCount: 1, messageCount: 1 },
    ],
    dailyModelTokens: [
      { date: "2026-10-01", tokensByModel: { fixture: 310 } },
      { date: "2026-10-29", tokensByModel: { fixture: 100 } },
    ],
    heatmap: [], providers: [],
  };
}

test("active-day averages exclude undated tokens while lifetime totals retain them", () => {
  const result = buildOverviewMetrics(overview(), "all");
  expect(result.totalTokens).toBe(570);
  expect(result.averageDailyTokens).toBe(205);
  expect(result.averageDailySessions).toBe(1);
  expect(result.activeDays).toBe(2);
});

test("a selected range uses only dated events within both boundaries", () => {
  const source = overview();
  source.dailyModelTokens.push({ date: "2026-10-30", tokensByModel: { fixture: 1000 } });
  const result = buildOverviewMetrics(source, "7d");
  expect(result.totalTokens).toBe(100);
  expect(result.sessions).toBe(1);
  expect(result.averageDailyTokens).toBe(100);
});

test("Sunday remains the last day of its own heatmap week", () => {
  const first = getHeatmapGridStart("2026-11-01", 26);
  expect(first.getDay()).toBe(1);
  expect(formatDateKey(first)).toBe("2026-05-04");
  expect(formatDateKey(addDays(first, 181))).toBe("2026-11-01");
});

test("a weekday shares the same grid as its following Sunday", () => {
  const first = getHeatmapGridStart("2026-10-29", 26);
  expect(formatDateKey(first)).toBe("2026-05-04");
  expect(formatDateKey(addDays(first, 181))).toBe("2026-11-01");
});

test("year and month boundaries retain Monday through Sunday alignment", () => {
  const first = getHeatmapGridStart("2027-01-01", 26);
  expect(first.getDay()).toBe(1);
  expect(formatDateKey(addDays(first, 181))).toBe("2027-01-03");
});
