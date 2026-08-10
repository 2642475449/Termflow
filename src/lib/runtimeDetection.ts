import type { ClaudeSessionMode } from "@/types";

export interface DetectedClaudeRuntimeState {
  model?: string | null;
  mode?: ClaudeSessionMode | null;
  silent?: boolean;
}

const ANSI_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping requires control chars.
  /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

const MODEL_CONTEXT_PATTERNS = [
  /\bmodel\s*[:=]\s*(claude[-\s]?(?:opus|sonnet|haiku)[\w.\- ]*)/i,
  /\busing\s+(claude[-\s]?(?:opus|sonnet|haiku)[\w.\- ]*)/i,
  /\bswitched to\s+(claude[-\s]?(?:opus|sonnet|haiku)[\w.\- ]*)/i,
  /\bcurrent model\s*[:=]\s*(claude[-\s]?(?:opus|sonnet|haiku)[\w.\- ]*)/i,
];

const MODEL_STATUS_PATTERN =
  /\b(claude[-\s]?(?:opus|sonnet|haiku)(?:[-\s]?\d+(?:\.\d+)*)?(?:[-\s]?[a-z0-9]+)*)\b/i;

const MODE_PATTERNS: Array<[ClaudeSessionMode, RegExp]> = [
  ["accept-edits", /\bauto(?:[-\s]?accept(?:ed)? edits?|[-\s]?apply mode|accept edits mode)\b/i],
  ["plan", /\bplan(?:ning)? mode\b/i],
  ["auto", /\bauto mode\b/i],
  ["default", /\bdefault mode\b/i],
];

export function detectClaudeRuntimeState(chunk: string): DetectedClaudeRuntimeState | null {
  const normalizedLines = sanitizeChunk(chunk);
  if (normalizedLines.length === 0) return null;

  let detectedModel: string | null | undefined;
  let detectedMode: ClaudeSessionMode | null | undefined;
  let detectedSilent: boolean | undefined;

  for (const line of normalizedLines) {
    if (detectedModel === undefined) {
      detectedModel = extractModel(line);
    }
    if (detectedMode === undefined) {
      detectedMode = extractMode(line);
    }
    if (detectedSilent === undefined) {
      detectedSilent = extractSilent(line);
    }

    if (detectedModel !== undefined && detectedMode !== undefined && detectedSilent !== undefined) {
      break;
    }
  }

  if (
    detectedModel === undefined &&
    detectedMode === undefined &&
    detectedSilent === undefined
  ) {
    return null;
  }

  return {
    model: detectedModel,
    mode: detectedMode,
    silent: detectedSilent,
  };
}

function sanitizeChunk(chunk: string): string[] {
  return chunk
    .replace(ANSI_PATTERN, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => line.length <= 120);
}

function extractModel(line: string): string | null | undefined {
  const contextualMatch = MODEL_CONTEXT_PATTERNS
    .map((pattern) => line.match(pattern)?.[1])
    .find(Boolean);
  if (contextualMatch) {
    return formatModelLabel(contextualMatch);
  }

  // Support compact CLI status lines such as "esc to interrupt | sonnet-4 | ..."
  if (!/[|]/.test(line)) {
    return undefined;
  }
  const statusMatch = line.match(MODEL_STATUS_PATTERN)?.[1];
  return statusMatch ? formatModelLabel(statusMatch) : undefined;
}

function extractMode(line: string): ClaudeSessionMode | null | undefined {
  for (const [mode, pattern] of MODE_PATTERNS) {
    if (pattern.test(line)) return mode;
  }
  return undefined;
}

function extractSilent(line: string): boolean | undefined {
  if (/\bsilent mode (?:off|disabled)\b/i.test(line)) return false;
  if (/\bsilent mode\b/i.test(line)) return true;
  return undefined;
}

function formatModelLabel(value: string): string {
  const cleaned = value
    .replace(/\s+/g, " ")
    .replace(/\|.*$/, "")
    .replace(/[)\]}]+$/, "")
    .trim();

  return cleaned
    .split(/[-\s]+/)
    .map((part) => {
      if (/^\d/.test(part) || /^[a-z]\d$/i.test(part)) return part.toUpperCase();
      if (/^(claude|opus|sonnet|haiku)$/i.test(part)) {
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      }
      return part;
    })
    .join(" ");
}
