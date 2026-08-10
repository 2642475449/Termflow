import type { TerminalQuickCommand } from "@/types";
import { isQuickCommandComplete } from "./quickCommands";

// ── 常量 ─────────────────────────────────────────────────────

const SEARCH_QUERY_MAX_BYTES = 2 * 1024;

// ── 搜索文本规范化 ───────────────────────────────────────────

/**
 * 判断字符是否为空白字符
 * 包括标准空白、NBSP、各种 Unicode 空白等
 */
function isWhitespace(code: number): boolean {
  return (
    code === 32 || // 空格
    (code >= 9 && code <= 13) || // tab, LF, VT, FF, CR
    code === 160 || // NBSP
    code === 5760 || // Ogham space mark
    (code >= 8192 && code <= 8202) || // 各种 Unicode 空白
    code === 8232 || // 行分隔符
    code === 8233 || // 段落分隔符
    code === 8239 || // 窄不换行空格
    code === 8287 || // 数学空格
    code === 12288 || // 表意空格
    code === 65279 // 零宽不换行空格
  );
}

/**
 * 规范化搜索文本
 * - 转小写
 * - 连续空白折叠为单个空格
 * - 去除首尾空白
 */
export function normalizeSearchText(text: string): string {
  let result = "";
  let lastWasSpace = true; // 开头视为已有空格，跳过前导空白

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const lower = String.fromCharCode(code).toLowerCase();

    if (isWhitespace(code)) {
      if (!lastWasSpace) {
        result += " ";
        lastWasSpace = true;
      }
    } else {
      result += lower;
      lastWasSpace = false;
    }
  }

  // 去除尾部空白
  if (lastWasSpace && result.length > 0) {
    result = result.slice(0, -1);
  }

  return result;
}

// ── 评分算法 ─────────────────────────────────────────────────

/**
 * 对单个字段进行评分
 *
 * 匹配方式与附加分：
 * - 完全相等：baseScore
 * - 前缀匹配：baseScore + 50
 * - 单词开头匹配：baseScore + 100 + 位置
 * - 子串匹配：baseScore + 200 + 位置
 * - 不匹配：Infinity
 */
function scoreCandidate(
  query: string,
  candidate: string,
  baseScore: number,
): number {
  if (candidate.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  // 完全相等
  if (candidate === query) {
    return baseScore;
  }

  // 前缀匹配
  if (candidate.startsWith(query)) {
    return baseScore + 50;
  }

  // 单词开头匹配（前面是空格）
  const wordIndex = candidate.indexOf(` ${query}`);
  if (wordIndex !== -1) {
    return baseScore + 100 + wordIndex;
  }

  // 子串匹配
  const subIndex = candidate.indexOf(query);
  if (subIndex !== -1) {
    return baseScore + 200 + subIndex;
  }

  return Number.POSITIVE_INFINITY;
}

/**
 * 计算单条命令的搜索分数（越低越靠前）
 *
 * 字段基础分：
 * - 标签：0
 * - 命令正文：400
 *
 * 取所有字段中的最低分
 */
export function scoreQuickCommand(
  query: string,
  command: TerminalQuickCommand,
): number {
  const labelScore = scoreCandidate(query, command.label.toLowerCase(), 0);
  const bodyScore = scoreCandidate(query, command.command.toLowerCase(), 400);

  return Math.min(labelScore, bodyScore);
}

// ── 搜索过滤和排序 ──────────────────────────────────────────

/**
 * 搜索快速命令
 *
 * - 查询超过 2KB 返回空结果
 * - 同时匹配标签和命令正文
 * - 按评分排序，相同分数保持原列表顺序
 * - 空查询返回所有完整命令（保持原序）
 */
export function searchQuickCommands(
  query: string,
  commands: TerminalQuickCommand[],
): TerminalQuickCommand[] {
  // 只搜索完整命令
  const completeCommands = commands.filter(isQuickCommandComplete);

  // 空查询返回所有完整命令
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return completeCommands;
  }

  // 查询大小保护
  if (new TextEncoder().encode(trimmed).length > SEARCH_QUERY_MAX_BYTES) {
    return [];
  }

  const normalizedQuery = normalizeSearchText(trimmed);
  if (normalizedQuery.length === 0) {
    return completeCommands;
  }

  // 评分并过滤不匹配项
  const scored: Array<{ command: TerminalQuickCommand; score: number; index: number }> = [];

  for (let i = 0; i < completeCommands.length; i++) {
    const cmd = completeCommands[i];
    const normalizedLabel = normalizeSearchText(cmd.label);
    const normalizedBody = normalizeSearchText(cmd.command);

    const labelScore = scoreCandidate(normalizedQuery, normalizedLabel, 0);
    const bodyScore = scoreCandidate(normalizedQuery, normalizedBody, 400);
    const score = Math.min(labelScore, bodyScore);

    if (score !== Number.POSITIVE_INFINITY) {
      scored.push({ command: cmd, score, index: i });
    }
  }

  // 按分数排序，相同分数保持原序
  scored.sort((a, b) => a.score - b.score || a.index - b.index);

  return scored.map((s) => s.command);
}

// ── 首选命令选择 ─────────────────────────────────────────────

/**
 * 获取菜单中应预选的命令
 *
 * - 空查询：优先选中 preferredCommandId，否则选第一条
 * - 非空查询：选中第一条搜索结果
 */
export function getQuickCommandPickerValue(
  query: string,
  filteredCommands: TerminalQuickCommand[],
  preferredCommandId: string | null,
): TerminalQuickCommand | null {
  if (filteredCommands.length === 0) {
    return null;
  }

  if (query.trim().length === 0 && preferredCommandId) {
    const preferred = filteredCommands.find(
      (c) => c.id === preferredCommandId,
    );
    if (preferred) {
      return preferred;
    }
  }

  return filteredCommands[0];
}
