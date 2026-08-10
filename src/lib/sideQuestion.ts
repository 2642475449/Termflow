export const SIDE_QUESTION_MAX_CONTEXT_CHARS = 24_000;

export const SIDE_QUESTION_PRESETS = [
  {
    id: "explain",
    labelKey: "terminal.sideQuestionPresetExplain",
    questionKey: "terminal.sideQuestionPresetExplainQuestion",
  },
  {
    id: "failure",
    labelKey: "terminal.sideQuestionPresetFailure",
    questionKey: "terminal.sideQuestionPresetFailureQuestion",
  },
  {
    id: "fix",
    labelKey: "terminal.sideQuestionPresetFix",
    questionKey: "terminal.sideQuestionPresetFixQuestion",
  },
  {
    id: "next",
    labelKey: "terminal.sideQuestionPresetNext",
    questionKey: "terminal.sideQuestionPresetNextQuestion",
  },
] as const;

export interface SanitizedTerminalSelection {
  text: string;
  lineCount: number;
  truncated: boolean;
  potentialSecret: boolean;
}

const SECRET_PATTERNS = [
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function containsPotentialSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export function canSubmitSideQuestion(
  question: string,
  selection: SanitizedTerminalSelection | null,
): boolean {
  return Boolean(question.trim() && selection?.text.trim());
}

export function sanitizeTerminalSelection(
  selection: string,
  maxChars = SIDE_QUESTION_MAX_CONTEXT_CHARS,
): SanitizedTerminalSelection {
  const withoutAnsi = selection
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-_]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim();
  const truncated = withoutAnsi.length > maxChars;
  const lineCount = withoutAnsi ? withoutAnsi.split("\n").length : 0;
  const text = truncated
    ? `${withoutAnsi.slice(0, maxChars).trimEnd()}\n…`
    : withoutAnsi;

  return {
    text,
    lineCount,
    truncated,
    potentialSecret: containsPotentialSecret(withoutAnsi),
  };
}

export function buildSideQuestionPrompt(input: {
  question: string;
  context: string;
  sourceSessionName: string;
  projectPath: string;
}): string {
  const contextBlock = input.context.trim()
    ? [
        `来源会话：${input.sourceSessionName}`,
        `工作目录：${input.projectPath}`,
        "<terminal_selection>",
        input.context.trim().replaceAll("</terminal_selection>", "<\\/terminal_selection>"),
        "</terminal_selection>",
        "",
      ]
    : [];

  return [
    ...contextBlock,
    "用户问题：",
    input.question.trim(),
  ].join("\n");
}
