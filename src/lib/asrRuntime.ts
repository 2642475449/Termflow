export type AsrTransport = "dashscope" | "native-proxy";

export type AsrErrorCode =
  | "permission_denied"
  | "no_microphone"
  | "no_api_key"
  | "not_supported"
  | "network"
  | "http_4xx"
  | "http_5xx"
  | "timeout"
  | "empty_audio"
  | "unknown";

export interface AsrError {
  code: AsrErrorCode;
  message: string;
}

const DASHSCOPE_MODELS = new Set([
  "fun-asr-flash-2026-06-15",
  "qwen3-asr-flash",
  "qwen3-asr-flash-2026-02-10",
  "qwen3-asr-flash-2025-09-08",
]);

const ASR_ERROR_CODES = new Set<AsrErrorCode>([
  "permission_denied",
  "no_microphone",
  "no_api_key",
  "not_supported",
  "network",
  "http_4xx",
  "http_5xx",
  "timeout",
  "empty_audio",
  "unknown",
]);

export function getAsrTransport(model: string): AsrTransport {
  return DASHSCOPE_MODELS.has(model) ? "dashscope" : "native-proxy";
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function extractErrorMessage(error: unknown): string | null {
  const direct = nonEmptyString(error);
  if (direct) return direct;
  if (!error || typeof error !== "object") return null;

  const record = error as Record<string, unknown>;
  return (
    nonEmptyString(record.message) ??
    nonEmptyString(record.detail) ??
    extractErrorMessage(record.error)
  );
}

export function normalizeAsrError(error: unknown, fallbackMessage = "未知错误"): AsrError {
  const record = error && typeof error === "object"
    ? error as Record<string, unknown>
    : null;
  const candidateCode = record?.code;
  const code = typeof candidateCode === "string" && ASR_ERROR_CODES.has(candidateCode as AsrErrorCode)
    ? candidateCode as AsrErrorCode
    : "unknown";

  return {
    code,
    message: extractErrorMessage(error) ?? fallbackMessage,
  };
}
