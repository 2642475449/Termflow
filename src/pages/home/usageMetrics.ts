import type { AgentUsageDailyModelTokens, AgentUsageOverview } from "@/types";

export type RangeKey = "all" | "30d" | "7d";

export interface OverviewMetrics {
  sessions: number;
  messages: number;
  totalTokens: number;
  averageDailySessions: number;
  averageDailyMessages: number;
  averageDailyTokens: number;
  averageWeeklySessions: number;
  averageWeeklyMessages: number;
  averageWeeklyTokens: number;
  peakDailyTokens: number;
  peakWeeklyTokens: number;
  longestSessionMs: number;
  activeDays: number;
  activeWeeks: number;
  currentStreak: number;
  longestStreak: number;
  peakHour: number | null;
  favoriteModel: string;
}

export function parseDate(input: string): Date {
  const [year, month, day] = input.split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

export function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(date: Date, offset: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + offset);
  return next;
}

function getRangeStart(lastComputedDate: string | null, range: RangeKey): Date | null {
  if (!lastComputedDate || range === "all") {
    return null;
  }
  const end = parseDate(lastComputedDate);
  return addDays(end, range === "7d" ? -6 : -29);
}

function isDateInRange(dateKey: string, lastComputedDate: string | null, range: RangeKey): boolean {
  if (!lastComputedDate || range === "all") {
    return true;
  }
  const date = parseDate(dateKey);
  const start = getRangeStart(lastComputedDate, range);
  const end = parseDate(lastComputedDate);
  if (!start) {
    return true;
  }
  return date >= start && date <= end;
}

export function getFilteredDailyTokens(
  entries: AgentUsageDailyModelTokens[],
  lastComputedDate: string | null,
  range: RangeKey
): AgentUsageDailyModelTokens[] {
  return entries.filter((entry) => isDateInRange(entry.date, lastComputedDate, range));
}

export function buildOverviewMetrics(overview: AgentUsageOverview, range: RangeKey): OverviewMetrics {
  const filteredActivity = overview.dailyActivity.filter((entry) =>
    isDateInRange(entry.date, overview.lastComputedDate, range)
  );
  const filteredTokens = getFilteredDailyTokens(
    overview.dailyModelTokens,
    overview.lastComputedDate,
    range
  );

  const activeDates = filteredActivity
    .filter((entry) => entry.messageCount > 0 || entry.sessionCount > 0)
    .map((entry) => entry.date);

  const modelTotals = new Map<string, number>();
  let computedTotalTokens = 0;
  const dailyTotals = filteredTokens.map((entry) =>
    Object.values(entry.tokensByModel).reduce((sum, count) => sum + count, 0)
  );

  // 统一分母：使用两个数据源的日期并集
  const allDates = new Set([
    ...filteredActivity.map((e) => e.date),
    ...filteredTokens.map((e) => e.date),
  ]);
  const unifiedDayCount = allDates.size || 1;

  const weeklyTotals = new Map<string, number>();
  const weeklySessions = new Map<string, number>();
  const weeklyMessages = new Map<string, number>();
  for (const entry of filteredTokens) {
    const currentDate = parseDate(entry.date);
    const weekStart = addDays(currentDate, -currentDate.getDay());
    const weekKey = formatDateKey(weekStart);
    const dayTotal = Object.values(entry.tokensByModel).reduce((sum, count) => sum + count, 0);
    weeklyTotals.set(weekKey, (weeklyTotals.get(weekKey) ?? 0) + dayTotal);
  }
  for (const entry of filteredActivity) {
    const currentDate = parseDate(entry.date);
    const weekStart = addDays(currentDate, -currentDate.getDay());
    const weekKey = formatDateKey(weekStart);
    weeklySessions.set(weekKey, (weeklySessions.get(weekKey) ?? 0) + entry.sessionCount);
    weeklyMessages.set(weekKey, (weeklyMessages.get(weekKey) ?? 0) + entry.messageCount);
  }

  for (const entry of filteredTokens) {
    for (const [model, count] of Object.entries(entry.tokensByModel)) {
      modelTotals.set(model, (modelTotals.get(model) ?? 0) + count);
      computedTotalTokens += count;
    }
  }

  const computedFavoriteModel =
    [...modelTotals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
    overview.summary.favoriteModel ??
    "N/A";
  const totalTokens = range === "all" ? overview.summary.totalTokens : computedTotalTokens;
  const sessions =
    range === "all"
      ? overview.summary.totalSessions
      : filteredActivity.reduce((sum, entry) => sum + entry.sessionCount, 0);
  const messages =
    range === "all"
      ? overview.summary.totalMessages
      : filteredActivity.reduce((sum, entry) => sum + entry.messageCount, 0);
  const activeDays = range === "all" ? overview.summary.activeDays : activeDates.length;
  const favoriteModel =
    range === "all"
      ? overview.summary.favoriteModel ?? computedFavoriteModel
      : computedFavoriteModel;

  return {
    sessions,
    messages,
    totalTokens,
    averageDailySessions:
      unifiedDayCount > 0
        ? Math.round(
            filteredActivity.reduce((sum, entry) => sum + entry.sessionCount, 0) /
              unifiedDayCount
          )
        : 0,
    averageDailyMessages:
      unifiedDayCount > 0
        ? Math.round(
            filteredActivity.reduce((sum, entry) => sum + entry.messageCount, 0) /
              unifiedDayCount
          )
        : 0,
    averageDailyTokens:
      unifiedDayCount > 0
        ? Math.round(computedTotalTokens / unifiedDayCount)
        : 0,
    averageWeeklySessions:
      weeklySessions.size > 0
        ? Math.round(
            [...weeklySessions.values()].reduce((sum, value) => sum + value, 0) /
              weeklySessions.size
          )
        : 0,
    averageWeeklyMessages:
      weeklyMessages.size > 0
        ? Math.round(
            [...weeklyMessages.values()].reduce((sum, value) => sum + value, 0) /
              weeklyMessages.size
          )
        : 0,
    averageWeeklyTokens:
      weeklyTotals.size > 0
        ? Math.round(computedTotalTokens / weeklyTotals.size)
        : 0,
    peakDailyTokens: Math.max(
      0,
      ...dailyTotals
    ),
    peakWeeklyTokens: Math.max(0, ...weeklyTotals.values()),
    longestSessionMs: overview.summary.longestSessionMs,
    activeDays,
    activeWeeks: weeklyMessages.size,
    currentStreak: overview.summary.currentStreakDays,
    longestStreak: overview.summary.longestStreakDays,
    peakHour: overview.summary.peakHour,
    favoriteModel,
  };
}

export function getHeatmapGridStart(asOf: string | null, weekCount: number, now = new Date()): Date {
  const end = asOf ? parseDate(asOf) : now;
  const sunday = addDays(end, (7 - end.getDay()) % 7);
  return addDays(sunday, -(weekCount * 7 - 1));
}
