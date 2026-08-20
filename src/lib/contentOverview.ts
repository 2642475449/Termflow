export const CONTENT_OVERVIEW_MAX_BUFFER_CHARS = 256_000;
export const CONTENT_OVERVIEW_MIN_SCORE = 1_500;

export interface ContentOverviewSection {
  id: string;
  title: string;
  level: 1 | 2 | 3;
  anchorText: string;
}

export interface ContentOverview {
  sessionId: string;
  turnId: string;
  summary: string;
  keyPoints: string[];
  sections: ContentOverviewSection[];
  coverage: "complete" | "partial";
  generatedAt: number;
}

export interface ContentOverviewSessionSnapshot {
  canGenerate: boolean;
  hasContent: boolean;
  contentUpdated: boolean;
  overview: ContentOverview | null;
}

interface SessionRuntime {
  raw: string;
  score: number;
  capturing: boolean;
  turnId: string;
  contentUpdated: boolean;
  overview: ContentOverview | null;
  snapshot: ContentOverviewSessionSnapshot;
  listeners: Set<() => void>;
}

const EMPTY_SNAPSHOT: ContentOverviewSessionSnapshot = {
  canGenerate: false,
  hasContent: false,
  contentUpdated: false,
  overview: null,
};

const runtimes = new Map<string, SessionRuntime>();
const navigators = new Map<string, (anchorText: string) => boolean>();
const outputSources = new Map<string, Set<symbol>>();

function createRuntime(): SessionRuntime {
  return {
    raw: "",
    score: 0,
    capturing: false,
    turnId: createTurnId(),
    contentUpdated: false,
    overview: null,
    snapshot: EMPTY_SNAPSHOT,
    listeners: new Set(),
  };
}

function getRuntime(sessionId: string): SessionRuntime {
  let runtime = runtimes.get(sessionId);
  if (!runtime) {
    runtime = createRuntime();
    runtimes.set(sessionId, runtime);
  }
  return runtime;
}

function createTurnId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function updateSnapshot(runtime: SessionRuntime): void {
  runtime.snapshot = {
    canGenerate: runtime.score >= CONTENT_OVERVIEW_MIN_SCORE,
    hasContent: runtime.score > 0,
    contentUpdated: runtime.contentUpdated,
    overview: runtime.overview,
  };
  runtime.listeners.forEach((listener) => listener());
}

export function beginContentOverviewTurn(sessionId: string): void {
  const runtime = getRuntime(sessionId);
  runtime.raw = "";
  runtime.score = 0;
  runtime.capturing = true;
  runtime.turnId = createTurnId();
  runtime.contentUpdated = false;
  runtime.overview = null;
  updateSnapshot(runtime);
}

export function appendContentOverviewOutput(sessionId: string, data: string): void {
  if (!data) return;
  const runtime = getRuntime(sessionId);
  if (!runtime.capturing) return;
  const wasEligible = runtime.snapshot.canGenerate;
  const wasUpdated = runtime.contentUpdated;
  const nextRaw = runtime.raw + data;
  runtime.raw = nextRaw.slice(-CONTENT_OVERVIEW_MAX_BUFFER_CHARS);
  runtime.score = nextRaw.length > CONTENT_OVERVIEW_MAX_BUFFER_CHARS
    ? getContentOverviewScore(cleanTerminalOverviewText(runtime.raw))
    : runtime.score + getContentOverviewScore(cleanTerminalOverviewText(data));
  if (runtime.overview) runtime.contentUpdated = true;

  const isEligible = runtime.score >= CONTENT_OVERVIEW_MIN_SCORE;
  if (wasEligible !== isEligible || (!wasUpdated && runtime.contentUpdated)) {
    updateSnapshot(runtime);
  }
}

export function registerContentOverviewOutputSource(sessionId: string): {
  append: (data: string) => void;
  dispose: () => void;
} {
  const sourceId = Symbol(sessionId);
  const sources = outputSources.get(sessionId) ?? new Set<symbol>();
  sources.add(sourceId);
  outputSources.set(sessionId, sources);

  return {
    append: (data) => {
      if (sources.values().next().value === sourceId) {
        appendContentOverviewOutput(sessionId, data);
      }
    },
    dispose: () => {
      sources.delete(sourceId);
      if (sources.size === 0) outputSources.delete(sessionId);
    },
  };
}

export function generateContentOverview(
  sessionId: string,
  options?: { partial?: boolean },
): ContentOverview | null {
  const runtime = getRuntime(sessionId);
  const cleanText = cleanTerminalOverviewText(runtime.raw);
  if (getContentOverviewScore(cleanText) < CONTENT_OVERVIEW_MIN_SCORE) return null;

  const extracted = extractContentOverview(cleanText);
  runtime.overview = {
    sessionId,
    turnId: runtime.turnId,
    ...extracted,
    coverage: options?.partial ? "partial" : "complete",
    generatedAt: Date.now(),
  };
  runtime.contentUpdated = false;
  updateSnapshot(runtime);
  return runtime.overview;
}

export function getContentOverviewSnapshot(sessionId: string): ContentOverviewSessionSnapshot {
  return runtimes.get(sessionId)?.snapshot ?? EMPTY_SNAPSHOT;
}

export function subscribeContentOverview(sessionId: string, listener: () => void): () => void {
  const runtime = getRuntime(sessionId);
  runtime.listeners.add(listener);
  return () => runtime.listeners.delete(listener);
}

export function registerContentOverviewNavigator(
  navigationId: string,
  navigate: (anchorText: string) => boolean,
): () => void {
  navigators.set(navigationId, navigate);
  return () => {
    if (navigators.get(navigationId) === navigate) navigators.delete(navigationId);
  };
}

export function navigateToContentOverviewSection(navigationId: string, anchorText: string): boolean {
  return navigators.get(navigationId)?.(anchorText) ?? false;
}

export function getContentOverviewScore(text: string): number {
  const compact = text.replace(/\s/g, "");
  const cjkCount = (compact.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  return compact.length + cjkCount * 0.875;
}

export function cleanTerminalOverviewText(raw: string): string {
  const withoutControlSequences = raw
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001bP[\s\S]*?\u001b\\/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, "");

  return withoutControlSequences
    .split(/\n/)
    .map((line) => line.slice(line.lastIndexOf("\r") + 1).trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒|/\\\-]+$/.test(trimmed)) return false;
      if (/^(thinking|working|processing|loading)[…. .]*$/i.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractContentOverview(text: string): Pick<ContentOverview, "summary" | "keyPoints" | "sections"> {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const sections: ContentOverviewSection[] = [];
  const sectionLineIndexes = new Set<number>();

  lines.forEach((line, index) => {
    const markdown = line.match(/^(#{1,3})\s+(.{2,100})$/);
    const numbered = line.match(/^(\d+(?:\.\d+){0,2})[.)、]?\s+(.{2,100})$/);
    const chinese = line.match(/^([一二三四五六七八九十]+)[、.]\s*(.{2,100})$/);
    const shortTitle = !markdown && !numbered && !chinese && isLikelyShortTitle(line, lines[index + 1])
      ? line
      : undefined;
    const title = markdown?.[2] ?? numbered?.[2] ?? chinese?.[2] ?? shortTitle;
    if (!title) return;
    const level = markdown
      ? Math.min(markdown[1].length, 3)
      : numbered
        ? Math.min(numbered[1].split(".").length, 3)
        : chinese
          ? 1
          : 2;
    const normalizedTitle = stripMarkdown(title);
    if (!normalizedTitle || sections.some((section) => section.title === normalizedTitle)) return;
    sectionLineIndexes.add(index);
    sections.push({
      id: `section-${sections.length + 1}`,
      title: normalizedTitle,
      level: level as 1 | 2 | 3,
      anchorText: stripMarkdown(line).slice(0, 120),
    });
  });

  const proseLines = lines.filter((line, index) => {
    if (sectionLineIndexes.has(index)) return false;
    const stripped = stripMarkdown(line);
    return stripped.length >= 12 && !isPromptLike(stripped);
  });
  const candidates = proseLines
    .filter((line) => /^(?:[-*•]|\d+[.)、])\s+/.test(line))
    .map((line) => stripMarkdown(line.replace(/^(?:[-*•]|\d+[.)、])\s+/, "")))
    .filter((line) => line.length >= 12 && line.length <= 220);

  const fallbackCandidates = proseLines
    .flatMap((line) => stripMarkdown(line).split(/(?<=[。！？.!?])\s*/))
    .filter((line) => line.length >= 18 && line.length <= 220);
  const keyPoints = uniqueStrings(candidates.length > 0 ? candidates : fallbackCandidates).slice(0, 4);
  const summarySource = fallbackCandidates[0] ?? proseLines[0] ?? sections[0]?.title ?? "";

  return {
    summary: truncateText(summarySource, 220),
    keyPoints,
    sections: sections.slice(0, 8),
  };
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/, "")
    .replace(/[*_`~]/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function isPromptLike(text: string): boolean {
  return /^(?:PS [^>]*>|[A-Z]:\\[^>]*>|[$#>❯])\s*/.test(text);
}

function isLikelyShortTitle(line: string, nextLine: string | undefined): boolean {
  if (!nextLine || line.length < 2 || line.length > 48) return false;
  if (/^(?:[-*•]|\d+[.)、]|[$#>❯])\s*/.test(line)) return false;
  if (/[。！？.!?，,：:;；]$/.test(line)) return false;
  return stripMarkdown(nextLine).length > line.length;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}
