import { stripAnsiEscapeSequences } from "./textContent";

const ERROR_CODES = [
  "capacity", "rateLimited", "authentication", "quota", "network", "timeout",
  "outputLimit", "emptyOutput", "unavailable", "invalidInput", "processFailed",
] as const;

export type GitCommitGenerationErrorCode = typeof ERROR_CODES[number];

export interface GitCommitGenerationError {
  code: GitCommitGenerationErrorCode;
  attempts: number;
  detail: string;
  exitCode: number | null;
}

function diagnosticExcerpt(raw: string): string {
  const lines = stripAnsiEscapeSequences(raw.slice(-8_192)).replace(/\r/g, "\n")
    .split("\n").map((line) => line.trim()).filter(Boolean);
  const important = lines.filter((line) => /^(?:error|fatal)[: ]/i.test(line));
  const selected = Array.from(new Set((important.length ? important : lines).slice(-3))).join(" ");
  return selected.length > 240 ? `${selected.slice(0, 239).trimEnd()}…` : selected;
}

/** Tauri 的结构化错误和旧版字符串错误统一归一化，不把整段提示词送入 Toast。 */
export function parseGitCommitGenerationError(error: unknown): GitCommitGenerationError {
  const raw = error instanceof Error ? error.message : error;
  let value: unknown = raw;
  if (typeof raw === "string" && raw.trimStart().startsWith("{")) {
    try { value = JSON.parse(raw); } catch { /* 旧版 CLI 文本按诊断摘要处理。 */ }
  }
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const code = ERROR_CODES.find((candidate) => candidate === record?.code) ?? "processFailed";
  const attempts = typeof record?.attempts === "number" && Number.isSafeInteger(record.attempts)
    ? Math.max(0, record.attempts) : 1;
  const detail = typeof record?.detail === "string" ? record.detail
    : typeof record?.message === "string" ? record.message : typeof raw === "string" ? raw : "";
  return {
    code,
    attempts,
    detail: diagnosticExcerpt(detail),
    exitCode: typeof record?.exitCode === "number" && Number.isSafeInteger(record.exitCode) ? record.exitCode : null,
  };
}
