import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { ExclamationCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import { Popover, Skeleton } from "antd";
import {
  AGENT_USAGE_HISTORY_CHANGED_EVENT,
  getAgentUsageOverview,
  getCachedAgentUsageOverview,
  getCachedAgentUsageOverviewUpdatedAt,
} from "@/lib/api";
import type {
  AgentUsageDailyModelTokens,
  AgentUsageHeatmapDay,
  AgentUsageOverview,
} from "@/types";
import { useAppStore } from "@/store";
import { useTranslation } from "react-i18next";
import { createGreetingSelection, getGreetingPeriod } from "./greeting";

type HomeTab = "overview" | "models";
type RangeKey = "all" | "30d" | "7d";

const OVERVIEW_AUTO_REFRESH_MS = 5 * 60 * 1000;
const OVERVIEW_REFRESH_CHECK_MS = 30 * 1000;
const GREETING_REFRESH_MS = 60 * 1000;

interface HeatmapColumn {
  key: string;
  monthLabel: string;
  cells: Array<{
    key: string;
    date: string;
    value: number;
    modelValues: Record<string, number>;
    isFuture: boolean;
    isPendingData: boolean;
  }>;
}

type HeatmapCell = HeatmapColumn["cells"][number];

interface HeatmapTooltip {
  cell: HeatmapCell;
  x: number;
  y: number;
}

interface OverviewMetrics {
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

interface ModelsChartData {
  dates: string[];
  models: string[];
  totals: Record<string, number>;
  rows: Array<{
    date: string;
    values: Record<string, number>;
    total: number;
  }>;
}

type ModelsChartRow = ModelsChartData["rows"][number];

interface ModelsChartTooltip {
  row: ModelsChartRow;
  x: number;
  y: number;
}

interface TokenDistributionItem {
  key: string;
  label: string;
  value: number;
  color: string;
}

function homeCopy(language: string, zh: string, en: string, ja: string): string {
  if (language === "zh-CN") {
    return zh;
  }
  if (language === "ja-JP" || language === "ja") {
    return ja;
  }
  return en;
}

function formatUsageScope(overview: AgentUsageOverview, language: string): string {
  const readableProviders = overview.providers
    .filter((provider) => provider.capability !== "unsupported")
    .map((provider) => provider.label);
  const unsupportedProviders = overview.providers
    .filter((provider) => provider.capability === "unsupported")
    .map((provider) => provider.label);
  const readable = readableProviders.join("、") || homeCopy(language, "暂无", "none", "なし");

  if (unsupportedProviders.length === 0) {
    return homeCopy(
      language,
      `统计范围：本机 ${readable} 的可读取使用记录，不按当前项目筛选。`,
      `Scope: readable local usage records from ${readable}; not limited to the current project.`,
      `集計範囲：ローカルの ${readable} から読み取れる使用記録です。現在のプロジェクトには限定されません。`
    );
  }

  const unsupported = unsupportedProviders.join("、");
  return homeCopy(
    language,
    `统计范围：本机 ${readable} 的可读取使用记录，不按当前项目筛选；${unsupported} 暂无稳定的本地用量来源，未计入。`,
    `Scope: readable local usage records from ${readable}; not limited to the current project. ${unsupported} are excluded because no stable local usage source is available.`,
    `集計範囲：ローカルの ${readable} から読み取れる使用記録で、現在のプロジェクトには限定されません。${unsupported} は安定したローカル使用量ソースがないため含まれません。`
  );
}

function parseDate(input: string): Date {
  const [year, month, day] = input.split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatRefreshTime(date: Date): string {
  const pad = (value: number) => `${value}`.padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function addDays(date: Date, offset: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + offset);
  return next;
}

const zhMonthLabels = [
  "一月",
  "二月",
  "三月",
  "四月",
  "五月",
  "六月",
  "七月",
  "八月",
  "九月",
  "十月",
  "十一月",
  "十二月",
];

function formatMonthLabel(date: Date, language: string): string {
  if (language === "zh-CN") {
    return zhMonthLabels[date.getMonth()] ?? `${date.getMonth() + 1}月`;
  }
  return new Intl.DateTimeFormat(language === "ja-JP" ? "ja-JP" : "en-US", {
    month: "short",
  }).format(date);
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

function formatTokenCount(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}
function getCompactTokenUnit(value: number, language: string): { divisor: number; suffix: string } | null {
  const safeValue = Math.max(0, value);
  const isCjkLocale = language === "zh-CN" || language === "zh-TW" || language === "ja-JP" || language === "ja";
  const isTraditionalChinese = language === "zh-TW";

  if (isCjkLocale) {
    if (safeValue >= 100_000_000) {
      return {
        divisor: 100_000_000,
        suffix: isTraditionalChinese || language === "ja-JP" || language === "ja" ? "億" : "亿",
      };
    }
    if (safeValue >= 10_000) {
      return { divisor: 10_000, suffix: isTraditionalChinese ? "萬" : "万" };
    }
    return null;
  }

  if (safeValue >= 1_000_000_000) {
    return { divisor: 1_000_000_000, suffix: "B" };
  }
  if (safeValue >= 1_000_000) {
    return { divisor: 1_000_000, suffix: "M" };
  }
  if (safeValue >= 1_000) {
    return { divisor: 1_000, suffix: "K" };
  }
  return null;
}

function formatTokenCountWithUnit(value: number, unit: { divisor: number; suffix: string }): string {
  const scaledValue = Math.max(0, value) / unit.divisor;
  const maximumFractionDigits = scaledValue >= 1_000 ? 0 : scaledValue >= 100 ? 1 : 2;
  const formattedValue = scaledValue.toLocaleString("en-US", {
    useGrouping: false,
    maximumFractionDigits,
  });
  return `${formattedValue} ${unit.suffix}`;
}

function formatCompactTokenCount(value: number, language: string): string {
  const unit = getCompactTokenUnit(value, language);
  return unit ? formatTokenCountWithUnit(value, unit) : formatTokenCount(value);
}

function formatModelUsageAxisTick(value: number, axisMaximum: number, language: string): string {
  const safeValue = Math.max(0, value);
  if (safeValue === 0) {
    return "0";
  }

  const unit = getCompactTokenUnit(axisMaximum, language);
  return unit ? formatTokenCountWithUnit(safeValue, unit) : formatTokenCount(safeValue);
}
function formatHourRange(hour: number | null, language: string): string {
  if (hour === null || !Number.isFinite(hour)) {
    return "--";
  }
  const start = Math.min(23, Math.max(0, Math.trunc(hour)));
  const end = (start + 1) % 24;
  if (language === "zh-CN" || language === "zh-TW") {
    return `${start}–${end} 点`;
  }
  if (language === "ja-JP" || language === "ja") {
    return `${start}時–${end}時`;
  }
  const formatHour = (value: number) => `${value}`.padStart(2, "0");
  return `${formatHour(start)}:00–${formatHour(end)}:00`;
}

function formatModelChartDateLabel(date: string, language: string): string {
  const parsed = parseDate(date);
  if (language === "zh-CN") {
    return `${parsed.getMonth() + 1}/${parsed.getDate()}`;
  }
  return new Intl.DateTimeFormat(language === "ja-JP" ? "ja-JP" : "en-US", {
    month: "short",
    day: "numeric",
  }).format(parsed);
}

function getFilteredDailyTokens(
  entries: AgentUsageDailyModelTokens[],
  lastComputedDate: string | null,
  range: RangeKey
): AgentUsageDailyModelTokens[] {
  return entries.filter((entry) => isDateInRange(entry.date, lastComputedDate, range));
}

function buildOverviewMetrics(overview: AgentUsageOverview, range: RangeKey): OverviewMetrics {
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
        ? Math.round(totalTokens / unifiedDayCount)
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
        ? Math.round(totalTokens / weeklyTotals.size)
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

// 热力图显示的周数（26 周 ≈ 182 天 ≈ 180 天，保持周对齐的视觉节奏）
const HEATMAP_WEEK_COUNT = 26;

// 星期标签（顺序与 cells 的 rowIndex 一致：周一 → 周日）
const WEEK_LABELS_ZH = ["一", "二", "三", "四", "五", "六", "日"];
const WEEK_LABELS_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEK_LABELS_JA = ["月", "火", "水", "木", "金", "土", "日"];

function buildHeatmapColumns(
  heatmapData: AgentUsageHeatmapDay[],
  dailyModelTokens: AgentUsageDailyModelTokens[],
  lastComputedDate: string | null,
  language: string
): HeatmapColumn[] {
  const dailyMap = new Map<string, number>();
  for (const entry of heatmapData) {
    dailyMap.set(entry.date, entry.tokenCount);
  }
  const dailyModelMap = new Map<string, Record<string, number>>();
  for (const entry of dailyModelTokens) {
    const values = Object.fromEntries(
      Object.entries(entry.tokensByModel).filter(
        ([model, value]) => isDisplayableModelName(model) && value > 0
      )
    );
    dailyModelMap.set(entry.date, values);
  }

  const endDate = lastComputedDate ? parseDate(lastComputedDate) : new Date();
  const gridEnd = addDays(endDate, 6 - endDate.getDay());
  const gridStart = addDays(gridEnd, -(HEATMAP_WEEK_COUNT * 7 - 1));
  const today = formatDateKey(new Date());
  const dataCutoff = lastComputedDate ?? today;

  const columns: HeatmapColumn[] = [];
  let previousMonthToken = "";

  for (let columnIndex = 0; columnIndex < HEATMAP_WEEK_COUNT; columnIndex++) {
    // 每列从周一开始：cells[0] = 周一, ..., cells[6] = 周日
    const columnStart = addDays(gridStart, 1 + columnIndex * 7);

    // 计算一周中哪个月份的天数最多（解决跨月标签问题）
    const monthCounts = new Map<string, number>();
    for (let i = 0; i < 7; i++) {
      const currentDate = addDays(columnStart, i);
      const monthKey = `${currentDate.getFullYear()}-${currentDate.getMonth()}`;
      monthCounts.set(monthKey, (monthCounts.get(monthKey) ?? 0) + 1);
    }
    let dominantMonth = "";
    let maxCount = 0;
    for (const [month, count] of monthCounts) {
      if (count > maxCount) {
        maxCount = count;
        dominantMonth = month;
      }
    }
    const monthToken = dominantMonth;

    // 使用该周中间日期（周三）来格式化月份标签
    const midWeekDate = addDays(columnStart, 3);
    const monthLabel =
      monthToken === previousMonthToken ? "" : formatMonthLabel(midWeekDate, language);
    previousMonthToken = monthToken;

    const cells = Array.from({ length: 7 }, (_, rowIndex) => {
      const currentDate = addDays(columnStart, rowIndex);
      const dateKey = formatDateKey(currentDate);
      return {
        key: `${dateKey}-${language}`,
        date: dateKey,
        value: dailyMap.get(dateKey) ?? 0,
        modelValues: dailyModelMap.get(dateKey) ?? {},
        isFuture: dateKey > today,
        isPendingData: !!lastComputedDate && dateKey > dataCutoff && dateKey <= today,
      };
    });

    columns.push({
      key: `${columnStart.toISOString()}-${language}`,
      monthLabel,
      cells,
    });
  }

  return columns;
}

const HEATMAP_TOKEN_THRESHOLDS = [
  0,
  1,
  1_000_000,
  5_000_000,
  10_000_000,
  25_000_000,
] as const;

function getHeatLevel(value: number): number {
  if (value <= 0) return 0;
  if (value < 1_000_000) return 1;
  if (value < 5_000_000) return 2;
  if (value < 10_000_000) return 3;
  if (value < 25_000_000) return 4;
  return 5;
}

function getHeatLevelLabel(value: number, language: string): string {
  const labels = language === "zh-CN"
    ? ["无活动", "很少", "较少", "一般", "较多", "多"]
    : language === "ja-JP"
      ? ["アクティビティなし", "ごく少ない", "少ない", "普通", "多い", "非常に多い"]
      : ["No activity", "Very low", "Low", "Medium", "High", "Very high"];
  return labels[getHeatLevel(value)] ?? labels[0];
}

function getHeatColor(value: number, isDark: boolean): string {
  const surfaceBase = isDark
    ? "var(--cs-bg-card-solid, var(--cs-bg-card))"
    : "white";
  const level = getHeatLevel(value);
  if (level === 0) {
    return isDark
      ? "color-mix(in srgb, var(--cs-bg-hover) 52%, var(--cs-bg-card-solid, var(--cs-bg-card)) 48%)"
      : "color-mix(in srgb, var(--cs-bg-hover) 28%, white 72%)";
  }
  if (level === 1) {
    return `color-mix(in srgb, var(--cs-primary) ${isDark ? 20 : 16}%, ${surfaceBase} ${isDark ? 80 : 84}%)`;
  }
  if (level === 2) {
    return `color-mix(in srgb, var(--cs-primary) ${isDark ? 34 : 28}%, ${surfaceBase} ${isDark ? 66 : 72}%)`;
  }
  if (level === 3) {
    return `color-mix(in srgb, var(--cs-primary) ${isDark ? 48 : 44}%, ${surfaceBase} ${isDark ? 52 : 56}%)`;
  }
  if (level === 4) {
    return `color-mix(in srgb, var(--cs-primary) ${isDark ? 62 : 60}%, ${surfaceBase} ${isDark ? 38 : 40}%)`;
  }
  return isDark
    ? "color-mix(in srgb, var(--cs-primary) 94%, white 6%)"
    : "color-mix(in srgb, var(--cs-primary) 96%, black 4%)";
}

function isDisplayableModelName(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    normalized.length > 0 &&
    normalized !== "unknown" &&
    normalized !== "n/a" &&
    normalized !== "null" &&
    normalized !== "undefined"
  );
}

function buildModelsChartData(overview: AgentUsageOverview, range: RangeKey): ModelsChartData {
  const filtered = getFilteredDailyTokens(overview.dailyModelTokens, overview.lastComputedDate, range);
  const modelTotals = new Map<string, number>();

  for (const entry of filtered) {
    for (const [model, value] of Object.entries(entry.tokensByModel)) {
      if (!isDisplayableModelName(model) || value <= 0) {
        continue;
      }
      modelTotals.set(model, (modelTotals.get(model) ?? 0) + value);
    }
  }

  const models = [...modelTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([model]) => model);

  const rows = filtered
    .map((entry) => {
      const values: Record<string, number> = {};
      for (const model of models) {
        values[model] = entry.tokensByModel[model] ?? 0;
      }
      const total = models.reduce((sum, model) => sum + values[model], 0);
      return { date: entry.date, values, total };
    })
    .filter((row) => row.total > 0);

  return {
    dates: rows.map((row) => row.date),
    models,
    totals: Object.fromEntries(models.map((model) => [model, modelTotals.get(model) ?? 0])),
    rows,
  };
}

function HomePage() {
  const { t, i18n } = useTranslation();
  const windowMode = useAppStore((s) => s.windowMode);
  const currentProject = useAppStore((s) => s.currentProject);
  const themeCategory = useAppStore((s) => s.themeCategory);
  const systemPrefersDark = useAppStore((s) => s.systemPrefersDark);
  const cachedOverview = getCachedAgentUsageOverview(Number.POSITIVE_INFINITY);
  const cachedOverviewUpdatedAt = getCachedAgentUsageOverviewUpdatedAt();
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const hasOverviewRef = useRef(Boolean(cachedOverview));
  const [overview, setOverview] = useState<AgentUsageOverview | null>(cachedOverview);
  const [loading, setLoading] = useState(!cachedOverview);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(() =>
    cachedOverviewUpdatedAt ? new Date(cachedOverviewUpdatedAt) : null
  );
  const [activeTab, setActiveTab] = useState<HomeTab>("overview");
  const [range, setRange] = useState<RangeKey>("7d");
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(() => new Set());
  const [heatmapTooltip, setHeatmapTooltip] = useState<HeatmapTooltip | null>(null);
  const [chartTooltip, setChartTooltip] = useState<ModelsChartTooltip | null>(null);
  const [greetingSelection, setGreetingSelection] = useState(() =>
    createGreetingSelection(new Date())
  );
  const isDark =
    themeCategory === "dark" ||
    (themeCategory === "system" && systemPrefersDark);

  const subtitle =
    windowMode === "project" && currentProject
      ? homeCopy(
          i18n.language,
          `${currentProject.name} 已就绪，以下为本机智能体使用概览`,
          `${currentProject.name} is ready. Here is a local agent usage overview.`,
          `${currentProject.name} の準備ができました。以下はローカルのエージェント使用状況です。`
        )
      : t("home.overview.heroSubtitle");
  const greeting = t(
    `home.overview.greeting.${greetingSelection.period}.${greetingSelection.variant}`
  );

  useEffect(() => {
    const updateGreeting = () => {
      const now = new Date();
      const period = getGreetingPeriod(now);
      setGreetingSelection((current) =>
        current.period === period ? current : createGreetingSelection(now)
      );
    };
    const greetingTimer = window.setInterval(updateGreeting, GREETING_REFRESH_MS);
    window.addEventListener("focus", updateGreeting);

    return () => {
      window.clearInterval(greetingTimer);
      window.removeEventListener("focus", updateGreeting);
    };
  }, []);

  const refreshOverview = useCallback(async (options: {
    forceRefresh: boolean;
    showLoading: boolean;
  }) => {
    if (refreshInFlightRef.current) {
      return;
    }

    refreshInFlightRef.current = true;
    if (options.showLoading) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    setRefreshError(null);
    try {
      const result = await getAgentUsageOverview({ forceRefresh: options.forceRefresh });
      if (!mountedRef.current) {
        return;
      }
      hasOverviewRef.current = true;
      setOverview(result);
      setError(null);
      const updatedAt = getCachedAgentUsageOverviewUpdatedAt();
      setLastRefreshedAt(new Date(updatedAt ?? Date.now()));
    } catch (reason) {
      if (!mountedRef.current) {
        return;
      }
      const message = reason instanceof Error ? reason.message : String(reason);
      if (hasOverviewRef.current) {
        setRefreshError(message);
      } else {
        setError(message);
      }
    } finally {
      refreshInFlightRef.current = false;
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    const refreshIfStale = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      const updatedAt = getCachedAgentUsageOverviewUpdatedAt();
      if (!updatedAt || Date.now() - updatedAt >= OVERVIEW_AUTO_REFRESH_MS) {
        void refreshOverview({
          forceRefresh: true,
          showLoading: !hasOverviewRef.current,
        });
      }
    };
    const refreshAfterHistoryChange = () => {
      void refreshOverview({
        forceRefresh: true,
        showLoading: !hasOverviewRef.current,
      });
    };

    refreshIfStale();
    const refreshCheckTimer = window.setInterval(
      refreshIfStale,
      OVERVIEW_REFRESH_CHECK_MS
    );
    window.addEventListener("focus", refreshIfStale);
    window.addEventListener(AGENT_USAGE_HISTORY_CHANGED_EVENT, refreshAfterHistoryChange);
    document.addEventListener("visibilitychange", refreshIfStale);

    return () => {
      mountedRef.current = false;
      window.clearInterval(refreshCheckTimer);
      window.removeEventListener("focus", refreshIfStale);
      window.removeEventListener(AGENT_USAGE_HISTORY_CHANGED_EVENT, refreshAfterHistoryChange);
      document.removeEventListener("visibilitychange", refreshIfStale);
    };
  }, [refreshOverview]);

  const handleManualRefresh = () => {
    void refreshOverview({ forceRefresh: true, showLoading: false });
  };

  useEffect(() => {
    setHeatmapTooltip(null);
    setChartTooltip(null);
  }, [activeTab, range]);

  const metrics = useMemo(
    () => (overview ? buildOverviewMetrics(overview, "all") : null),
    [overview]
  );
  const usageScope = useMemo(
    () => (overview ? formatUsageScope(overview, i18n.language) : null),
    [overview, i18n.language]
  );

  const heatmapColumns = useMemo(
    () =>
      buildHeatmapColumns(
        overview?.heatmap ?? [],
        overview?.dailyModelTokens ?? [],
        overview?.lastComputedDate ?? null,
        i18n.language
      ),
    [overview, i18n.language]
  );

  const heatmapMonthLabels = useMemo(() => {
    const startIndexes = heatmapColumns
      .map((column, index) => (column.monthLabel ? index : -1))
      .filter((index) => index >= 0);

    return startIndexes.map((startIndex, index) => {
      const nextStartIndex = startIndexes[index + 1] ?? heatmapColumns.length;
      return {
        key: `${heatmapColumns[startIndex]?.key ?? startIndex}-month-label`,
        label: heatmapColumns[startIndex]?.monthLabel ?? "",
        startColumn: startIndex + 1,
        span: Math.max(1, nextStartIndex - startIndex),
      };
    });
  }, [heatmapColumns]);

  const chartData = useMemo(
    () => (overview ? buildModelsChartData(overview, range) : { dates: [], models: [], totals: {}, rows: [] }),
    [overview, range]
  );

  const chartTotal = useMemo(
    () => chartData.models.reduce((sum, model) => sum + (chartData.totals[model] ?? 0), 0),
    [chartData]
  );
  const visibleModels = useMemo(
    () => chartData.models.filter((model) => !hiddenModels.has(model)),
    [chartData.models, hiddenModels]
  );
  const visibleChartMax = useMemo(
    () =>
      Math.max(
        1,
        ...chartData.rows.map((row) =>
          visibleModels.reduce((sum, model) => sum + (row.values[model] ?? 0), 0)
        )
      ),
    [chartData.rows, visibleModels]
  );
  const modelDetails = useMemo(
    () =>
      chartData.models.map((model) => {
        const activeRows = chartData.rows.filter((row) => (row.values[model] ?? 0) > 0);
        const total = chartData.totals[model] ?? 0;
        return {
          model,
          total,
          share: chartTotal > 0 ? total / chartTotal : 0,
          activeDays: activeRows.length,
          lastUsed: activeRows[activeRows.length - 1]?.date ?? null,
        };
      }),
    [chartData, chartTotal]
  );

  const surfaceMixBase = isDark
    ? "var(--cs-bg-card-solid, var(--cs-bg-card))"
    : "white";
  const surfaceContrastBase = isDark
    ? "var(--cs-bg-app)"
    : "white";
  const panelShadow = isDark
    ? "0 14px 36px rgba(0,0,0,0.24)"
    : "0 10px 28px rgba(15,23,42,0.055)";
  const chartAxisTextColor = isDark
    ? "var(--cs-text-secondary)"
    : "color-mix(in srgb, var(--cs-text-secondary) 86%, white 14%)";
  const chartTooltipBackground = isDark
    ? "color-mix(in srgb, var(--cs-bg-card-solid, var(--cs-bg-card)) 96%, black 4%)"
    : "rgba(255,255,255,0.98)";
  const chartTooltipBorder = isDark
    ? "color-mix(in srgb, var(--cs-border-card) 76%, white 10%)"
    : "color-mix(in srgb, var(--cs-border-card) 86%, black 14%)";

  const locale = i18n.language;
  const updateHeatmapTooltip = (event: MouseEvent, cell: HeatmapCell) => {
    const modelCount = Object.values(cell.modelValues).filter((value) => value > 0).length;
    const tooltipWidth = 300;
    const tooltipHeight = Math.min(240, 90 + Math.min(modelCount, 6) * 28);
    const viewportPadding = 12;
    const tooltipGap = 14;
    const cellRect = event.currentTarget.getBoundingClientRect();
    const maxX = Math.max(viewportPadding, window.innerWidth - tooltipWidth - viewportPadding);
    const maxY = Math.max(viewportPadding, window.innerHeight - tooltipHeight - viewportPadding);
    const clampX = (value: number) => Math.min(Math.max(value, viewportPadding), maxX);
    const clampY = (value: number) => Math.min(Math.max(value, viewportPadding), maxY);
    const centeredX = cellRect.left + cellRect.width / 2 - tooltipWidth / 2;
    const centeredY = cellRect.top + cellRect.height / 2 - tooltipHeight / 2;
    const availableLeft = cellRect.left - viewportPadding;
    const availableRight = window.innerWidth - viewportPadding - cellRect.right;
    const fitsLeft = availableLeft >= tooltipWidth + tooltipGap;
    const fitsRight = availableRight >= tooltipWidth + tooltipGap;
    const prefersLeft = availableLeft >= availableRight;
    const fitsAbove = cellRect.top - tooltipGap - tooltipHeight >= viewportPadding;
    const fitsBelow = cellRect.bottom + tooltipGap + tooltipHeight <= window.innerHeight - viewportPadding;

    let x: number;
    let y: number;

    if (prefersLeft && fitsLeft) {
      x = cellRect.left - tooltipWidth - tooltipGap;
      y = clampY(centeredY);
    } else if (!prefersLeft && fitsRight) {
      x = cellRect.right + tooltipGap;
      y = clampY(centeredY);
    } else if (fitsLeft) {
      x = cellRect.left - tooltipWidth - tooltipGap;
      y = clampY(centeredY);
    } else if (fitsRight) {
      x = cellRect.right + tooltipGap;
      y = clampY(centeredY);
    } else if (fitsAbove) {
      x = clampX(centeredX);
      y = cellRect.top - tooltipHeight - tooltipGap;
    } else if (fitsBelow) {
      x = clampX(centeredX);
      y = cellRect.bottom + tooltipGap;
    } else {
      x = clampX(cellRect.left - tooltipWidth - tooltipGap);
      y = clampY(centeredY);
    }

    setHeatmapTooltip({ cell, x, y });
  };
  const updateChartTooltip = (event: MouseEvent, row: ModelsChartRow) => {
    const rect = chartContainerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const tooltipWidth = 320;
    const tooltipHeight = 220;
    const viewportPadding = 12;
    const preferredX = event.clientX + 14;
    const x = Math.min(
      Math.max(preferredX, viewportPadding),
      Math.max(viewportPadding, window.innerWidth - tooltipWidth - viewportPadding)
    );
    const hasSpaceBelow = rect.bottom + tooltipHeight + viewportPadding <= window.innerHeight;
    const y = hasSpaceBelow
      ? rect.bottom + 8
      : Math.max(viewportPadding, rect.top - tooltipHeight - 8);
    setChartTooltip({ row, x, y });
  };
  const tokenBreakdown = overview?.tokenBreakdown;
  const inputTokens = tokenBreakdown?.inputTokens ?? 0;
  const outputTokens = tokenBreakdown?.outputTokens ?? 0;
  const cacheReadTokens = tokenBreakdown?.cacheReadTokens ?? 0;
  const cacheCreationTokens = tokenBreakdown?.cacheCreationTokens ?? 0;
  const reasoningTokens = tokenBreakdown?.reasoningOutputTokens ?? 0;
  const knownTokenTotal =
    tokenBreakdown?.totalTokens ??
    inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens + reasoningTokens;
  const todayDateKey = overview?.lastComputedDate ?? formatDateKey(new Date());
  const todayActivity = overview?.dailyActivity.find((entry) => entry.date === todayDateKey);
  const todayModelTokens = overview?.dailyModelTokens.find(
    (entry) => entry.date === todayDateKey
  );
  const todayTokens = Object.values(todayModelTokens?.tokensByModel ?? {}).reduce(
    (sum, value) => sum + value,
    0
  );
  const colors = isDark
    ? [
        "#8ea2ff",
        "#38d39f",
        "#ffcf5a",
        "#ff8a65",
        "#d889ff",
        "#48c8ff",
        "#ff6fae",
        "#a6e35f",
        "#ffb052",
        "#6fe3dd",
        "#c8b6ff",
        "#f97070",
      ]
    : [
        "#4f63ff",
        "#08a86f",
        "#e69f00",
        "#ef5b45",
        "#a83ee8",
        "#008bd2",
        "#e43f8f",
        "#67a800",
        "#d36b00",
        "#00a6a6",
        "#7b61ff",
        "#d92d2d",
      ];
  const tokenDistributionColors = isDark
    ? ["#77a7ff", "#3ee58f", "#ffca3a", "#ff8a3d", "#b78cff", "#a8b3c7"]
    : ["#3f7cff", "#16b978", "#f5a900", "#ff6b35", "#8057d8", "#667085"];
  const tokenDistributionItems: TokenDistributionItem[] = tokenBreakdown
    ? [
        {
          key: "input",
          label: t("home.overview.tokenInput"),
          value: inputTokens,
          color: tokenDistributionColors[0],
        },
        {
          key: "output",
          label: t("home.overview.tokenOutput"),
          value: outputTokens,
          color: tokenDistributionColors[1],
        },
        {
          key: "cacheRead",
          label: homeCopy(i18n.language, "缓存读取", "Cache read", "キャッシュ読み取り"),
          value: cacheReadTokens,
          color: tokenDistributionColors[2],
        },
        {
          key: "cacheWrite",
          label: homeCopy(i18n.language, "缓存写入", "Cache write", "キャッシュ書き込み"),
          value: cacheCreationTokens,
          color: tokenDistributionColors[3],
        },
        {
          key: "reasoning",
          label: t("home.overview.tokenReasoning"),
          value: reasoningTokens,
          color: tokenDistributionColors[4],
        },
        {
          key: "other",
          label: t("home.overview.tokenOther"),
          value: tokenBreakdown.otherTokens ?? 0,
          color: tokenDistributionColors[5],
        },
      ].filter((item) => item.value > 0)
    : [];
  const tokenDistributionTotal =
    tokenDistributionItems.reduce((sum, item) => sum + item.value, 0) || knownTokenTotal;

  return (
    <div
      className="app-scrollbar-none flex h-full overflow-y-auto px-[clamp(12px,2vw,24px)] py-5"
      style={{ background: "var(--cs-bg-body)" }}
    >
      <div className="app-home-overview-container mx-auto flex min-h-full w-full max-w-[1120px] items-start justify-center">
        <div className="w-full">
          <div className="mb-5 flex items-start justify-between gap-8">
            <div>
              <h1
                className="m-0 text-[28px] font-semibold"
                style={{ color: "var(--cs-text-primary)" }}
              >
                {greeting}
              </h1>
              <div className="mt-2 text-[13px]" style={{ color: "var(--cs-text-secondary)" }}>
                {subtitle}
              </div>
              {usageScope && (
                <Popover
                  trigger="click"
                  placement="bottomLeft"
                  content={
                    <div className="max-w-[420px] text-xs leading-5" style={{ color: "var(--cs-text-secondary)" }}>
                      {usageScope}
                    </div>
                  }
                >
                  <button
                    type="button"
                    className="mt-2 inline-flex h-4 w-4 items-center justify-center rounded-full border-0 bg-transparent p-0 text-[13px]"
                    aria-label={homeCopy(i18n.language, "查看统计范围说明", "View usage scope details", "集計範囲の詳細を表示")}
                    style={{ color: "var(--cs-text-tertiary)" }}
                  >
                    <ExclamationCircleOutlined />
                  </button>
                </Popover>
              )}
            </div>

            <div
              className="mt-1 flex shrink-0 flex-col items-end text-[12px] font-medium"
              style={{ color: "var(--cs-text-tertiary)" }}
            >
                <div className="flex items-center">
                  <button
                    type="button"
                    onClick={handleManualRefresh}
                    disabled={refreshing}
                    className="flex h-8 w-8 items-center justify-center rounded-full border-0 bg-transparent p-0 text-[18px] transition-colors hover:bg-[var(--cs-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cs-primary)] disabled:cursor-wait disabled:opacity-60"
                    style={{ color: "var(--cs-text-primary)" }}
                    aria-label={t("home.overview.manualRefresh")}
                    title={t("home.overview.manualRefresh")}
                  >
                    <ReloadOutlined className={refreshing ? "animate-spin" : ""} />
                  </button>
                </div>
                <div className="mt-1.5 text-[11px] font-normal tabular-nums">
                  {t("home.overview.lastRefreshed")} {lastRefreshedAt ? formatRefreshTime(lastRefreshedAt) : "--"}
                </div>
                <span className="sr-only" aria-live="polite">
                  {refreshError
                    ? t("home.overview.refreshFailed", { message: refreshError })
                    : refreshing
                      ? t("home.overview.refreshing")
                      : ""}
                </span>
            </div>
          </div>

          <div
            className="mb-5 flex items-center gap-6 border-b"
            style={{ borderColor: "var(--cs-border-card)" }}
          >
            {(["overview", "models"] as HomeTab[]).map((tab) => {
              const active = activeTab === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className="px-0 pb-2.5 pt-1 text-[13px] font-semibold transition"
                  style={{
                    background: "transparent",
                    color: active ? "var(--cs-text-primary)" : "var(--cs-text-secondary)",
                    boxShadow: active ? "inset 0 -2px 0 0 var(--cs-primary)" : "none",
                  }}
                >
                  {tab === "overview" ? t("home.overview.tabOverview") : t("home.overview.tabModels")}
                </button>
              );
            })}
          </div>

          {loading ? (
            <Skeleton
              active
              title={false}
              paragraph={{ rows: 8 }}
              className="[&_.ant-skeleton-paragraph>li]:!bg-[var(--cs-bg-hover)]"
            />
          ) : error ? (
            <div className="py-8 text-sm" style={{ color: "var(--cs-text-secondary)" }}>
              {t("home.overview.error", { message: error })}
            </div>
          ) : !overview || !metrics ? (
            <div className="py-8 text-sm" style={{ color: "var(--cs-text-secondary)" }}>
              {t("home.overview.empty")}
            </div>
          ) : activeTab === "overview" ? (
            <div className="space-y-5">
              <div className="app-home-summary-grid grid gap-5">
                <section
                  className="app-home-summary-card rounded-[14px] border px-5 py-5"
                  style={{
                    borderColor: `color-mix(in srgb, var(--cs-border-card) 82%, ${surfaceMixBase} 18%)`,
                    background: `color-mix(in srgb, var(--cs-bg-card-solid, var(--cs-bg-card)) 96%, ${surfaceMixBase} 4%)`,
                    boxShadow: panelShadow,
                  }}
                >
                  <div className="mb-7 flex items-center gap-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-50 text-[14px] text-amber-600">☀</span>
                    <h2 className="m-0 text-[15px] font-semibold" style={{ color: "var(--cs-text-primary)" }}>
                      {t("home.overview.todayTitle")}
                    </h2>
                  </div>
                  <div className="grid grid-cols-3 divide-x" style={{ borderColor: "var(--cs-border-card)" }}>
                    {[
                      [
                        (todayActivity?.sessionCount ?? 0).toLocaleString(locale),
                        t("home.overview.todaySessions"),
                        t("home.overview.todayRecorded"),
                      ],
                      [
                        (todayActivity?.messageCount ?? 0).toLocaleString(locale),
                        t("home.overview.todayInteractions"),
                        t("home.overview.todayMessagesAndEvents"),
                      ],
                      [
                        formatCompactTokenCount(todayTokens, i18n.language),
                        t("home.overview.todayTokens"),
                        t("home.overview.todayLocalStats"),
                      ],
                    ].map(([value, label, caption]) => (
                      <div key={label} className="min-w-0 px-3 first:pl-0 last:pr-0">
                        <div className="truncate text-[20px] font-semibold" style={{ color: "var(--cs-text-primary)" }}>{value}</div>
                        <div className="mt-1.5 text-[12px]" style={{ color: "var(--cs-text-secondary)" }}>{label}</div>
                        <div className="mt-5 truncate text-[11px]" style={{ color: "var(--cs-text-tertiary)" }} title={caption}>{caption}</div>
                      </div>
                    ))}
                  </div>
                </section>

                <section
                  className="app-home-summary-card rounded-[14px] border px-5 py-5"
                  style={{
                    borderColor: `color-mix(in srgb, var(--cs-border-card) 82%, ${surfaceMixBase} 18%)`,
                    background: `color-mix(in srgb, var(--cs-bg-card-solid, var(--cs-bg-card)) 96%, ${surfaceMixBase} 4%)`,
                    boxShadow: panelShadow,
                  }}
                >
                  <div className="mb-7 flex items-center gap-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-50 text-[15px] text-emerald-600">◷</span>
                    <h2 className="m-0 text-[15px] font-semibold" style={{ color: "var(--cs-text-primary)" }}>
                      {t("home.overview.rhythmTitle")}
                    </h2>
                  </div>
                  <div className="grid grid-cols-[0.9fr_0.9fr_1.2fr] divide-x" style={{ borderColor: "var(--cs-border-card)" }}>
                    {[
                      [
                        t("home.overview.rhythmDayCount", { count: metrics.currentStreak }),
                        t("home.overview.rhythmCurrentStreak"),
                        t("home.overview.rhythmLongestStreak", { count: metrics.longestStreak }),
                      ],
                      [
                        t("home.overview.rhythmDayCount", { count: metrics.activeDays }),
                        t("home.overview.rhythmActiveDays"),
                        t("home.overview.rhythmUsageRecorded"),
                      ],
                      [
                        formatHourRange(metrics.peakHour, i18n.language),
                        t("home.overview.rhythmPeakHour"),
                        t("home.overview.rhythmLocalTime"),
                      ],
                    ].map(([value, label, caption]) => (
                      <div key={label} className="min-w-0 px-3 first:pl-0 last:pr-0">
                        <div
                          className="whitespace-nowrap text-[18px] font-semibold tabular-nums"
                          style={{ color: "var(--cs-text-primary)" }}
                          title={value}
                        >
                          {value}
                        </div>
                        <div className="mt-1.5 text-[12px]" style={{ color: "var(--cs-text-secondary)" }}>{label}</div>
                        <div className="mt-5 truncate text-[11px]" style={{ color: "var(--cs-text-tertiary)" }} title={caption}>{caption}</div>
                      </div>
                    ))}
                  </div>
                </section>

                <section
                  className="app-home-summary-card rounded-[14px] border px-5 py-5"
                  style={{
                    borderColor: `color-mix(in srgb, var(--cs-border-card) 82%, ${surfaceMixBase} 18%)`,
                    background: `color-mix(in srgb, var(--cs-bg-card-solid, var(--cs-bg-card)) 96%, ${surfaceMixBase} 4%)`,
                    boxShadow: panelShadow,
                  }}
                >
                  <div className="mb-7 flex items-center gap-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-50 text-[13px] text-blue-600">▥</span>
                    <h2 className="m-0 text-[15px] font-semibold" style={{ color: "var(--cs-text-primary)" }}>
                      {homeCopy(i18n.language, "使用规模", "Usage", "使用状況")}
                    </h2>
                  </div>
                  <div className="grid grid-cols-3 divide-x" style={{ borderColor: "var(--cs-border-card)" }}>
                    {[
                      [metrics.sessions.toLocaleString(locale), homeCopy(i18n.language, "任务 / 会话", "Tasks / sessions", "タスク / セッション"), homeCopy(i18n.language, `日均 ${metrics.averageDailySessions.toLocaleString(locale)}`, `${metrics.averageDailySessions.toLocaleString(locale)} daily avg`, `1 日平均 ${metrics.averageDailySessions.toLocaleString(locale)}`)],
                      [metrics.messages.toLocaleString(locale), homeCopy(i18n.language, "交互事件", "Interactions", "インタラクション"), homeCopy(i18n.language, `日均 ${metrics.averageDailyMessages.toLocaleString(locale)}`, `${metrics.averageDailyMessages.toLocaleString(locale)} daily avg`, `1 日平均 ${metrics.averageDailyMessages.toLocaleString(locale)}`)],
                      [formatCompactTokenCount(metrics.totalTokens, i18n.language), homeCopy(i18n.language, "总 Token", "Total tokens", "合計トークン"), ""],
                    ].map(([value, label, caption]) => (
                      <div key={label} className="min-w-0 px-3 first:pl-0 last:pr-0">
                        <div className="truncate text-[20px] font-semibold" style={{ color: "var(--cs-text-primary)" }}>{value}</div>
                        <div className="mt-1.5 text-[12px]" style={{ color: "var(--cs-text-secondary)" }}>{label}</div>
                        <div className="mt-5 text-[11px]" style={{ color: "var(--cs-text-tertiary)" }}>{caption || "\u00a0"}</div>
                      </div>
                    ))}
                  </div>
                </section>
              </div>

              <div
                className="rounded-[14px] border px-5 py-4"
                style={{
                  borderColor: `color-mix(in srgb, var(--cs-border-card) 78%, ${surfaceMixBase} 22%)`,
                  background:
                    `linear-gradient(180deg, color-mix(in srgb, var(--cs-bg-card-solid, var(--cs-bg-card)) 97%, ${surfaceMixBase} 3%) 0%, color-mix(in srgb, var(--cs-bg-card-solid, var(--cs-bg-card)) 99%, var(--cs-bg-hover) 1%) 100%)`,
                  boxShadow: "0 6px 18px rgba(15,23,42,0.028)",
                }}
              >
                <div className="mb-4 flex items-start justify-between gap-5">
                  <div>
                    <div
                      className="text-[16px] font-semibold"
                      style={{ color: "var(--cs-text-primary)" }}
                    >
                      {homeCopy(i18n.language, "Token 构成", "Token composition", "トークン構成")}
                    </div>
                    <div
                      className="mt-1 text-[12px]"
                      style={{ color: "var(--cs-text-tertiary)" }}
                    >
                      {homeCopy(i18n.language, "累计", "Total", "合計")} {formatTokenCount(tokenDistributionTotal)} {t("home.overview.tokenUnit")}
                    </div>
                  </div>
                  {cacheReadTokens > 0 && (
                    <span
                      className="shrink-0 rounded-full px-3 py-1 text-[11px] font-medium"
                      style={{
                        color: "var(--cs-primary)",
                        background: "color-mix(in srgb, var(--cs-primary) 8%, transparent)",
                      }}
                    >
                      {homeCopy(i18n.language, "缓存读取为主要构成", "Cache read is the largest share", "キャッシュ読み取りが最大の割合です")}
                    </span>
                  )}
                </div>

                {tokenDistributionItems.length === 0 ? (
                  <div
                    className="flex h-[74px] items-center justify-center rounded-[10px] text-[13px]"
                    style={{
                      background: `color-mix(in srgb, var(--cs-bg-hover) 54%, ${surfaceMixBase} 46%)`,
                      border: `1px solid color-mix(in srgb, var(--cs-border-card) 70%, ${surfaceMixBase} 30%)`,
                      color: "var(--cs-text-secondary)",
                    }}
                  >
                    {t("home.overview.empty")}
                  </div>
                ) : (
                  <>
                    <div
                      className="flex h-3 overflow-hidden rounded-[5px]"
                      style={{
                        background: `color-mix(in srgb, var(--cs-bg-hover) 55%, ${surfaceMixBase} 45%)`,
                        border: `1px solid color-mix(in srgb, var(--cs-border-card) 46%, transparent)`,
                      }}
                    >
                      {tokenDistributionItems.map((item) => (
                        <div
                          key={item.key}
                          className="h-full transition-[filter] hover:brightness-110"
                          style={{
                            background: item.color,
                            flexBasis: 0,
                            flexGrow: item.value,
                            minWidth: 8,
                          }}
                          title={`${item.label} · ${item.value.toLocaleString(locale)} ${t("home.overview.tokenUnit")}`}
                        />
                      ))}
                    </div>

                    <div className="app-home-token-legend mt-4 grid gap-x-5 gap-y-3">
                      {tokenDistributionItems.map((item) => (
                        <div key={item.key} className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                              style={{ background: item.color }}
                            />
                            <span
                              className="truncate text-[12px] font-semibold"
                              style={{ color: "var(--cs-text-secondary)" }}
                            >
                              {item.label}
                            </span>
                          </div>
                          <div
                            className="mt-1 text-[15px] font-semibold leading-none"
                            style={{ color: "var(--cs-text-primary)" }}
                          >
                            {formatTokenCount(item.value)}
                          </div>
                        </div>
                      ))}
                    </div>

                  </>
                )}
              </div>

              <div
                className="rounded-[14px] border px-5 py-5"
                style={{
                  borderColor: `color-mix(in srgb, var(--cs-border-card) 78%, ${surfaceMixBase} 22%)`,
                  background:
                    `linear-gradient(180deg, color-mix(in srgb, var(--cs-bg-card-solid, var(--cs-bg-card)) 97%, ${surfaceMixBase} 3%) 0%, color-mix(in srgb, var(--cs-bg-card-solid, var(--cs-bg-card)) 99%, var(--cs-bg-hover) 1%) 100%)`,
                  boxShadow: "0 6px 18px rgba(15,23,42,0.028)",
                }}
              >
                  <div className="mb-4 flex items-start justify-between gap-6">
                    <div>
                      <div
                        className="text-[16px] font-semibold"
                        style={{ color: "var(--cs-text-primary)" }}
                      >
                        {t("home.overview.title")}
                      </div>
                      <div
                        className="mt-1 text-[12px]"
                        style={{ color: "var(--cs-text-tertiary)" }}
                      >
                        {homeCopy(
                          i18n.language,
                          `近 ${HEATMAP_WEEK_COUNT * 7} 天 · ${HEATMAP_WEEK_COUNT} 周`,
                          `Last ${HEATMAP_WEEK_COUNT * 7} days · ${HEATMAP_WEEK_COUNT} weeks`,
                          `過去 ${HEATMAP_WEEK_COUNT * 7} 日 · ${HEATMAP_WEEK_COUNT} 週間`
                        )}
                      </div>
                    </div>

                    {/* 紧凑图例；颜色仍对应固定 Token 档位。 */}
                    <div
                      className="flex shrink-0 items-center gap-2 text-[11px]"
                      style={{ color: "var(--cs-text-tertiary)" }}
                      aria-label={homeCopy(i18n.language, "固定单日 Token 档位", "Fixed daily token levels", "1 日あたりの固定トークン区分")}
                    >
                      <span>{homeCopy(i18n.language, "少", "Less", "少")}</span>
                      <div className="flex items-center gap-[3px]">
                        {HEATMAP_TOKEN_THRESHOLDS.map((value, index) => {
                          const labels = i18n.language === "zh-CN"
                            ? ["0 Token", "1–100万 Token", "100–500万 Token", "500–1000万 Token", "1000–2500万 Token", "2500万 Token 以上"]
                            : i18n.language === "ja-JP"
                              ? ["0 トークン", "1–100万トークン", "100–500万トークン", "500–1000万トークン", "1000–2500万トークン", "2500万トークン以上"]
                              : ["0 tokens", "1–1M tokens", "1–5M tokens", "5–10M tokens", "10–25M tokens", "25M+ tokens"];
                          return (
                            <span
                              key={value}
                              className="block h-[10px] w-[10px] rounded-[3px]"
                              style={{
                                background: getHeatColor(value, isDark),
                                border: "1px solid color-mix(in srgb, var(--cs-border-card) 22%, transparent)",
                              }}
                              title={labels[index]}
                            />
                          );
                        })}
                      </div>
                      <span>{homeCopy(i18n.language, "多", "More", "多")}</span>
                    </div>
                  </div>

                  <div
                    className="grid gap-x-[7px] gap-y-[5px]"
                    style={{
                      gridTemplateColumns: `20px repeat(${HEATMAP_WEEK_COUNT}, minmax(0, 1fr))`,
                      gridAutoRows: "minmax(0, 1fr)",
                    }}
                  >
                    {/* 第 1 列：星期标签（周一 → 周日，与 cells rowIndex 一一对应） */}
                    {(i18n.language === "zh-CN"
                      ? WEEK_LABELS_ZH
                      : i18n.language === "ja-JP"
                        ? WEEK_LABELS_JA
                        : WEEK_LABELS_EN
                    ).map(
                      (weekLabel, rowIndex) => (
                        <div
                          key={`week-label-${weekLabel}`}
                          className="flex items-center justify-end pr-1 text-[11px] font-semibold leading-none tracking-wide"
                          style={{
                            color: "var(--cs-text-secondary)",
                            gridColumn: 1,
                            gridRow: rowIndex + 1,
                          }}
                        >
                          {weekLabel}
                        </div>
                      )
                    )}

                    {/* 第 2-27 列：26 周 × 7 天 = 182 个方块 */}
                    {heatmapColumns.map((column, columnIndex) =>
                      column.cells.map((cell, rowIndex) => (
                        <div
                          key={cell.key}
                          aria-label={`${cell.date} · ${cell.isFuture
                            ? t("home.overview.futureDate")
                            : cell.isPendingData
                              ? t("home.overview.pendingDataDate")
                              : getHeatLevelLabel(cell.value, i18n.language)}`}
                          onMouseEnter={(event) => updateHeatmapTooltip(event, cell)}
                          onMouseLeave={() => setHeatmapTooltip(null)}
                          className="aspect-square w-full rounded-[5px] transition-all duration-150 hover:scale-110 hover:z-10"
                          style={{
                            background: cell.isFuture
                              ? `color-mix(in srgb, var(--cs-bg-hover) 12%, ${surfaceContrastBase} 88%)`
                              : cell.isPendingData
                                ? "color-mix(in srgb, var(--cs-primary) 8%, var(--cs-bg-hover) 92%)"
                                : getHeatColor(cell.value, isDark),
                            border: cell.isFuture
                              ? "1px solid color-mix(in srgb, var(--cs-border-card) 12%, transparent)"
                              : cell.isPendingData
                                ? "1px dashed color-mix(in srgb, var(--cs-primary) 24%, transparent)"
                                : cell.value > 0
                                  ? "1px solid color-mix(in srgb, var(--cs-primary) 18%, transparent)"
                                  : "1px solid color-mix(in srgb, var(--cs-border-card) 24%, transparent)",
                            opacity: cell.isFuture ? 0.35 : cell.isPendingData ? 0.75 : 1,
                            minWidth: "0",
                            boxShadow:
                              cell.value > 0
                                ? "inset 0 0 0 1px rgba(255,255,255,0.08)"
                                : "none",
                            gridColumn: columnIndex + 2,
                            gridRow: rowIndex + 1,
                          }}
                        />
                      ))
                    )}
                  </div>

                  <div
                    className="mt-3 grid gap-x-[7px]"
                    style={{
                      gridTemplateColumns: `20px repeat(${HEATMAP_WEEK_COUNT}, minmax(0, 1fr))`,
                    }}
                  >
                    {/* 第 1 列：占位（与上方星期标签列对齐空白） */}
                    <div />

                    {/* 第 2-27 列：月份标签（从第 2 列起） */}
                    {heatmapMonthLabels.map((label) => (
                      <div
                        key={label.key}
                        className="min-w-0 whitespace-nowrap text-[11px] font-semibold leading-none tracking-wide"
                        style={{
                          color: "var(--cs-text-secondary)",
                          gridColumn: `${label.startColumn + 1} / span ${label.span}`,
                        }}
                      >
                        {label.label}
                      </div>
                    ))}
                  </div>
                  {heatmapTooltip &&
                    (() => {
                      const modelEntries = Object.entries(heatmapTooltip.cell.modelValues)
                        .filter(([, value]) => value > 0)
                        .sort((a, b) => b[1] - a[1]);
                      const statusOnly =
                        heatmapTooltip.cell.isFuture || heatmapTooltip.cell.isPendingData;

                      return (
                    <div
                      className="pointer-events-none fixed z-50 max-h-[240px] w-[300px] overflow-y-auto rounded-[8px] border px-3 py-2 text-[12px] shadow-[0_14px_36px_rgba(15,23,42,0.18)]"
                      style={{
                        left: heatmapTooltip.x,
                        top: heatmapTooltip.y,
                        background: chartTooltipBackground,
                        borderColor: chartTooltipBorder,
                        color: "var(--cs-text-primary)",
                      }}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="text-[13px] font-semibold leading-tight">
                            {heatmapTooltip.cell.date}
                          </div>
                          <div
                            className="mt-0.5 text-[11px] leading-tight"
                            style={{ color: "var(--cs-text-tertiary)" }}
                          >
                            {heatmapTooltip.cell.isFuture
                              ? t("home.overview.futureDate")
                              : heatmapTooltip.cell.isPendingData
                                ? t("home.overview.pendingDataDate")
                                : homeCopy(i18n.language, "模型明细", "Model breakdown", "モデル内訳")}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div
                            className="text-[11px] leading-tight"
                            style={{ color: "var(--cs-text-tertiary)" }}
                          >
                            {statusOnly
                              ? homeCopy(i18n.language, "状态", "Status", "状態")
                              : homeCopy(i18n.language, "总量", "Total", "合計")}
                          </div>
                          <div className="mt-0.5 text-[13px] font-semibold leading-tight tabular-nums">
                            {heatmapTooltip.cell.isFuture
                              ? t("home.overview.futureDate")
                              : heatmapTooltip.cell.isPendingData
                                ? t("home.overview.pendingDataDate")
                                : `${formatTokenCount(heatmapTooltip.cell.value)} ${t("home.overview.tokenUnit")}`}
                          </div>
                        </div>
                      </div>

                      {!statusOnly && (
                        <div
                          className="mt-2 flex items-center justify-between rounded-[6px] px-2 py-1.5"
                          style={{
                            background: `color-mix(in srgb, var(--cs-bg-hover) 58%, ${surfaceMixBase} 42%)`,
                          }}
                        >
                          <span
                            className="text-[11px]"
                            style={{ color: "var(--cs-text-tertiary)" }}
                          >
                            {homeCopy(i18n.language, "活跃等级", "Activity level", "アクティビティレベル")}
                          </span>
                          <span
                            className="flex items-center gap-1.5 text-[11px] font-semibold"
                            style={{ color: "var(--cs-text-secondary)" }}
                          >
                            <span
                              className="h-2.5 w-2.5 rounded-[3px]"
                              style={{ background: getHeatColor(heatmapTooltip.cell.value, isDark) }}
                            />
                            {getHeatLevelLabel(heatmapTooltip.cell.value, i18n.language)}
                          </span>
                        </div>
                      )}

                      {!statusOnly && (
                        <div
                          className="mt-2 space-y-1 border-t pt-2"
                          style={{
                            borderColor: `color-mix(in srgb, var(--cs-border-card) 72%, ${surfaceMixBase} 28%)`,
                          }}
                        >
                          {modelEntries.length > 0 ? (
                            modelEntries.map(([model, value]) => (
                              <div
                                key={`${heatmapTooltip.cell.date}-${model}-heatmap-tooltip`}
                                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4"
                              >
                                <span
                                  className="truncate"
                                  style={{ color: "var(--cs-text-secondary)" }}
                                >
                                  {model}
                                </span>
                                <span className="text-right font-semibold tabular-nums">
                                  {formatTokenCount(value)} {t("home.overview.tokenUnit")}
                                </span>
                              </div>
                            ))
                          ) : (
                            <div
                              className="text-[12px]"
                              style={{ color: "var(--cs-text-tertiary)" }}
                            >
                              {homeCopy(
                                i18n.language,
                                "\u6682\u65e0\u6a21\u578b\u660e\u7ec6",
                                "No model breakdown",
                                "モデル内訳はありません"
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                      );
                    })()}
              </div>

              {metrics.totalTokens > 0 && (
                <div className="mt-4 text-[13px] font-medium" style={{ color: "var(--cs-text-secondary)" }}>
                  {homeCopy(
                    i18n.language,
                    `截至目前，项目已累计处理 ${metrics.totalTokens.toLocaleString(locale)} Token；上方热力图展示最近 ${HEATMAP_WEEK_COUNT * 7} 天的活动分布。`,
                    `The project has processed ${metrics.totalTokens.toLocaleString(locale)} tokens; the heatmap above shows activity from the last ${HEATMAP_WEEK_COUNT * 7} days.`,
                    `プロジェクトはこれまでに ${metrics.totalTokens.toLocaleString(locale)} トークンを処理しました。上のヒートマップは過去 ${HEATMAP_WEEK_COUNT * 7} 日間のアクティビティを示しています。`
                  )}
                </div>
              )}
            </div>
            ) : (
              <div className="space-y-5">
                <div
                  className="overflow-hidden rounded-[14px] border"
                  style={{
                    borderColor: `color-mix(in srgb, var(--cs-border-card) 82%, ${surfaceMixBase} 18%)`,
                    background: `color-mix(in srgb, var(--cs-bg-card) 92%, ${surfaceMixBase} 8%)`,
                    boxShadow: panelShadow,
                  }}
                >
                <div
                  className="flex items-center justify-between border-b px-5 py-2.5"
                  style={{
                    borderColor: `color-mix(in srgb, var(--cs-border-card) 72%, ${surfaceMixBase} 28%)`,
                    background:
                      `linear-gradient(180deg, color-mix(in srgb, var(--cs-bg-hover) 28%, ${surfaceMixBase} 72%) 0%, color-mix(in srgb, var(--cs-bg-card-solid, var(--cs-bg-card)) 96%, ${surfaceMixBase} 4%) 100%)`,
                  }}
                >
                  <div className="text-[13px] font-semibold" style={{ color: "var(--cs-text-secondary)" }}>
                    {homeCopy(i18n.language, "模型用量趋势", "Model usage trend", "モデル使用量の推移")}
                  </div>

                  <div className="flex items-center gap-5">
                    {(["30d", "7d"] as RangeKey[]).map((value) => {
                      const active = range === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setRange(value)}
                          className="px-0 py-1 text-[13px] font-semibold transition"
                          style={{
                            background: "transparent",
                            color: active ? "var(--cs-text-primary)" : "var(--cs-text-tertiary)",
                            boxShadow: active
                              ? "inset 0 -2px 0 0 color-mix(in srgb, var(--cs-primary) 34%, transparent)"
                              : "none",
                          }}
                        >
                          {value === "30d"
                              ? t("home.overview.range30d")
                              : t("home.overview.range7d")}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="p-4">
                {chartData.rows.length === 0 ? (
                  <div
                    className="flex h-[272px] items-center justify-center rounded-[10px] text-sm"
                    style={{
                      background: `color-mix(in srgb, var(--cs-bg-hover) 62%, ${surfaceMixBase} 38%)`,
                      border: `1px solid color-mix(in srgb, var(--cs-border-card) 78%, ${surfaceMixBase} 22%)`,
                      color: "var(--cs-text-secondary)",
                    }}
                  >
                    {t("home.overview.empty")}
                  </div>
                ) : (
                <div
                  ref={chartContainerRef}
                  className="relative h-[272px] overflow-hidden rounded-[10px] px-4 py-3"
                  onMouseLeave={() => setChartTooltip(null)}
                  style={{
                    background: `color-mix(in srgb, var(--cs-bg-hover) 62%, ${surfaceMixBase} 38%)`,
                    border: `1px solid color-mix(in srgb, var(--cs-border-card) 78%, ${surfaceMixBase} 22%)`,
                  }}
                >
                  <div
                    className="absolute inset-x-4 bottom-10 top-3"
                  >
                    <div className="relative h-full">
                      {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
                        <div
                          key={tick}
                          className="absolute left-0 right-0 border-t"
                          style={{
                            borderColor: `color-mix(in srgb, var(--cs-border-card) 55%, ${surfaceMixBase} 45%)`,
                            bottom: `${tick * 100}%`,
                          }}
                        />
                      ))}

                      <div
                        className="absolute bottom-0 left-12 right-2 top-0 flex items-end"
                        style={{ gap: range === "7d" ? 12 : 3 }}
                      >
                        {chartData.rows.map((row) => {
                          const visibleRowTotal = visibleModels.reduce(
                            (sum, model) => sum + (row.values[model] ?? 0),
                            0
                          );
                          return (
                            <div
                              key={row.date}
                              className="flex h-full min-w-0 flex-1 items-end justify-center"
                              onMouseEnter={(event) => updateChartTooltip(event, row)}
                              onMouseMove={(event) => updateChartTooltip(event, row)}
                            >
                              <div
                                className="flex max-w-full overflow-hidden rounded-t-[3px]"
                                style={{
                                  height: `${(visibleRowTotal / visibleChartMax) * 100}%`,
                                  width: range === "7d" ? "min(34px, 76%)" : "clamp(4px, 72%, 12px)",
                                  minWidth: range === "7d" ? 14 : 3,
                                  boxShadow: "0 1px 2px rgba(15,23,42,0.08)",
                                  flexDirection: "column-reverse",
                                }}
                              >
                                {visibleModels.map((model) => {
                                  const value = row.values[model] ?? 0;
                                  const colorIndex = chartData.models.indexOf(model);
                                  if (value <= 0 || visibleRowTotal <= 0) {
                                    return null;
                                  }
                                  return (
                                    <div
                                      key={`${row.date}-${model}`}
                                      className="w-full"
                                      style={{
                                        flexBasis: `${(value / visibleRowTotal) * 100}%`,
                                        background: colors[colorIndex % colors.length],
                                      }}
                                    />
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <div
                        className="absolute bottom-0 left-0 top-0 flex flex-col justify-between text-[14px] font-semibold"
                        style={{ color: chartAxisTextColor }}
                      >
                        {[visibleChartMax, visibleChartMax * 0.75, visibleChartMax * 0.5, visibleChartMax * 0.25, 0].map((tick) => (
                          <span key={tick}>
                            {formatModelUsageAxisTick(tick, visibleChartMax, i18n.language)}
                          </span>
                        ))}
                      </div>

                      <div
                        className="absolute bottom-[-30px] left-12 right-2 flex justify-between text-[13px] font-semibold"
                        style={{ color: chartAxisTextColor }}
                      >
                        {chartData.dates.length > 0
                          ? chartData.dates.map((date, index) => {
                              if (
                                index !== 0 &&
                                index !== chartData.dates.length - 1 &&
                                index % Math.ceil(chartData.dates.length / 5) !== 0
                              ) {
                                return (
                                  <span
                                    key={date}
                                    aria-hidden="true"
                                    className="w-0 shrink-0 opacity-0"
                                  />
                                );
                              }
                              return (
                                <span key={date} className="shrink-0 whitespace-nowrap leading-none">
                                  {formatModelChartDateLabel(date, i18n.language)}
                                </span>
                              );
                            })
                          : null}
                      </div>
                    </div>
                  </div>
                  {chartTooltip && (
                    <div
                      className="pointer-events-none fixed z-50 max-h-[220px] w-[320px] overflow-y-auto rounded-[8px] border px-3 py-2 text-[12px] shadow-[0_14px_36px_rgba(15,23,42,0.18)]"
                      style={{
                        left: chartTooltip.x,
                        top: chartTooltip.y,
                        background: chartTooltipBackground,
                        borderColor: chartTooltipBorder,
                        color: "var(--cs-text-primary)",
                      }}
                    >
                      <div
                        className="flex items-start justify-between gap-4 border-b pb-2"
                        style={{
                          borderColor: `color-mix(in srgb, var(--cs-border-card) 72%, ${surfaceMixBase} 28%)`,
                        }}
                      >
                        <div className="min-w-0">
                          <div className="text-[13px] font-semibold leading-tight">
                            {chartTooltip.row.date}
                          </div>
                          <div
                            className="mt-0.5 text-[11px] leading-tight"
                            style={{ color: "var(--cs-text-tertiary)" }}
                          >
                            {homeCopy(i18n.language, "模型明细", "Model breakdown", "モデル内訳")}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div
                            className="text-[11px] leading-tight"
                            style={{ color: "var(--cs-text-tertiary)" }}
                          >
                            {homeCopy(i18n.language, "总量", "Total", "合計")}
                          </div>
                          <div className="mt-0.5 text-[13px] font-semibold leading-tight tabular-nums">
                            {formatTokenCount(
                              visibleModels.reduce(
                                (sum, model) => sum + (chartTooltip.row.values[model] ?? 0),
                                0
                              )
                            )} {t("home.overview.tokenUnit")}
                          </div>
                        </div>
                      </div>

                      <div className="mt-2 space-y-1">
                        {visibleModels.map((model) => {
                          const value = chartTooltip.row.values[model] ?? 0;
                          const colorIndex = chartData.models.indexOf(model);
                          if (value <= 0) {
                            return null;
                          }
                          return (
                            <div
                              key={`${chartTooltip.row.date}-${model}-tooltip`}
                              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4"
                            >
                              <div className="flex min-w-0 items-center gap-2">
                                <span
                                  className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                                  style={{ background: colors[colorIndex % colors.length] }}
                                />
                                <span className="truncate" style={{ color: "var(--cs-text-secondary)" }}>
                                  {model}
                                </span>
                              </div>
                              <div className="text-right font-semibold tabular-nums">
                                {formatTokenCount(value)} {t("home.overview.tokenUnit")}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
                )}

                <div
                  className="hidden"
                  style={{
                    background: chartTooltip
                      ? chartTooltipBackground
                      : `color-mix(in srgb, var(--cs-bg-hover) 36%, ${surfaceMixBase} 64%)`,
                    borderColor: chartTooltip
                      ? chartTooltipBorder
                      : `color-mix(in srgb, var(--cs-border-card) 58%, ${surfaceMixBase} 42%)`,
                    color: "var(--cs-text-primary)",
                    opacity: chartTooltip ? 1 : 0.72,
                  }}
                >
                  {chartTooltip ? (
                    <>
                      <div
                        className="flex items-start justify-between gap-6 border-b pb-2"
                        style={{
                          borderColor: `color-mix(in srgb, var(--cs-border-card) 72%, ${surfaceMixBase} 28%)`,
                        }}
                      >
                        <div className="min-w-0">
                          <div className="text-[13px] font-semibold leading-tight">
                            {chartTooltip.row.date}
                          </div>
                          <div
                            className="mt-0.5 text-[11px] leading-tight"
                            style={{ color: "var(--cs-text-tertiary)" }}
                          >
                            {homeCopy(i18n.language, "模型明细", "Model breakdown", "モデル内訳")}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div
                            className="text-[11px] leading-tight"
                            style={{ color: "var(--cs-text-tertiary)" }}
                          >
                            {homeCopy(i18n.language, "总量", "Total", "合計")}
                          </div>
                          <div className="mt-0.5 text-[13px] font-semibold leading-tight tabular-nums">
                            {formatTokenCount(chartTooltip.row.total)} {t("home.overview.tokenUnit")}
                          </div>
                        </div>
                      </div>

                      <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 md:grid-cols-2">
                        {chartData.models.map((model, index) => {
                          const value = chartTooltip.row.values[model] ?? 0;
                          if (value <= 0) {
                            return null;
                          }
                          return (
                            <div
                              key={`${chartTooltip.row.date}-${model}-detail`}
                              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4"
                            >
                              <div className="flex min-w-0 items-center gap-2">
                                <span
                                  className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                                  style={{ background: colors[index % colors.length] }}
                                />
                                <span className="truncate" style={{ color: "var(--cs-text-secondary)" }}>
                                  {model}
                                </span>
                              </div>
                              <div className="text-right font-semibold tabular-nums">
                                {formatTokenCount(value)} {t("home.overview.tokenUnit")}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  ) : (
                    <div className="flex h-full min-h-[66px] items-center" />
                  )}
                </div>

                <div className="mt-4 grid grid-cols-1 gap-x-5 gap-y-2 sm:grid-cols-2 xl:grid-cols-4">
                  {chartData.models.map((model, index) => {
                    const hidden = hiddenModels.has(model);
                    const total = chartData.totals[model] ?? 0;
                    const share =
                      chartTotal > 0
                        ? `${((total / chartTotal) * 100).toFixed(1)}%`
                        : "0%";
                    return (
                      <button
                        key={model}
                        type="button"
                        onClick={() =>
                          setHiddenModels((current) => {
                            const next = new Set(current);
                            if (next.has(model)) {
                              next.delete(model);
                            } else {
                              next.add(model);
                            }
                            return next;
                          })
                        }
                        className="flex min-w-0 items-center justify-between gap-3 rounded-[6px] border-0 bg-transparent px-1.5 py-1 text-left transition-opacity hover:bg-[var(--cs-bg-hover)]"
                        style={{ opacity: hidden ? 0.4 : 1 }}
                        aria-pressed={!hidden}
                        title={homeCopy(
                          i18n.language,
                          hidden ? `显示 ${model}` : `隐藏 ${model}`,
                          hidden ? `Show ${model}` : `Hide ${model}`,
                          hidden ? `${model} を表示` : `${model} を非表示`
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className="h-3 w-3 shrink-0 rounded-[3px]"
                            style={{
                              background: colors[index % colors.length],
                              boxShadow: "0 1px 2px rgba(15,23,42,0.08)",
                            }}
                          />
                          <span
                            className="truncate text-[12px] font-semibold"
                            style={{ color: "var(--cs-text-primary)" }}
                          >
                            {model}
                          </span>
                        </span>
                        <span
                          className="shrink-0 whitespace-nowrap text-[11px] font-semibold tabular-nums"
                          style={{ color: "var(--cs-text-secondary)" }}
                        >
                          {formatTokenCount(total)} · {share}
                        </span>
                      </button>
                    );
                  })}
                </div>
                </div>
              </div>

              <div
                className="overflow-hidden rounded-[14px] border"
                style={{
                  borderColor: `color-mix(in srgb, var(--cs-border-card) 82%, ${surfaceMixBase} 18%)`,
                  background: `color-mix(in srgb, var(--cs-bg-card) 92%, ${surfaceMixBase} 8%)`,
                  boxShadow: panelShadow,
                }}
              >
                <div
                  className="border-b px-5 py-3 text-[13px] font-semibold"
                  style={{
                    borderColor: `color-mix(in srgb, var(--cs-border-card) 72%, ${surfaceMixBase} 28%)`,
                    color: "var(--cs-text-secondary)",
                  }}
                >
                  {homeCopy(i18n.language, "模型明细", "Model details", "モデル詳細")}
                </div>

                <div className="overflow-x-auto px-4 pb-3">
                  <div className="min-w-[680px]">
                    <div
                      className="grid grid-cols-[minmax(200px,1.7fr)_minmax(110px,1fr)_80px_90px_120px] gap-4 border-b px-2 py-2.5 text-[11px] font-semibold"
                      style={{
                        borderColor: "var(--cs-border-card)",
                        color: "var(--cs-text-tertiary)",
                      }}
                    >
                      <span>{homeCopy(i18n.language, "模型", "Model", "モデル")}</span>
                      <span>{t("home.overview.tokenUnit")}</span>
                      <span>{homeCopy(i18n.language, "占比", "Share", "割合")}</span>
                      <span>{homeCopy(i18n.language, "活跃天数", "Active days", "アクティブ日数")}</span>
                      <span>{homeCopy(i18n.language, "最近使用", "Last used", "最終使用")}</span>
                    </div>

                    {modelDetails.map((detail, index) => (
                      <div
                        key={`model-detail-${detail.model}`}
                        className="grid grid-cols-[minmax(200px,1.7fr)_minmax(110px,1fr)_80px_90px_120px] items-center gap-4 border-b px-2 py-2.5 text-[12px] last:border-b-0"
                        style={{
                          borderColor: `color-mix(in srgb, var(--cs-border-card) 66%, transparent)`,
                          color: "var(--cs-text-secondary)",
                        }}
                      >
                        <span className="flex min-w-0 items-center gap-2 font-semibold" style={{ color: "var(--cs-text-primary)" }}>
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                            style={{ background: colors[index % colors.length] }}
                          />
                          <span className="truncate">{detail.model}</span>
                        </span>
                        <span className="font-semibold tabular-nums">
                          {formatTokenCount(detail.total)}
                        </span>
                        <span className="tabular-nums">{(detail.share * 100).toFixed(1)}%</span>
                        <span className="tabular-nums">{detail.activeDays}</span>
                        <span className="tabular-nums">{detail.lastUsed ?? "--"}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

export default HomePage;
