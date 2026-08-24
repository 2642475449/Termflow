export const SIDE_QUESTION_MAX_CONTEXT_CHARS = 24_000;
export const SIDE_QUESTION_MAX_RESOURCES = 100;

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

export const RESOURCE_SIDE_QUESTION_PRESETS = [
  {
    id: "explain",
    labelKey: "sidebar.sideQuestionPresetExplain",
    questionKey: "sidebar.sideQuestionPresetExplainQuestion",
  },
  {
    id: "review",
    labelKey: "sidebar.sideQuestionPresetReview",
    questionKey: "sidebar.sideQuestionPresetReviewQuestion",
  },
  {
    id: "change",
    labelKey: "sidebar.sideQuestionPresetChange",
    questionKey: "sidebar.sideQuestionPresetChangeQuestion",
  },
  {
    id: "related",
    labelKey: "sidebar.sideQuestionPresetRelated",
    questionKey: "sidebar.sideQuestionPresetRelatedQuestion",
  },
] as const;

export interface SanitizedTerminalSelection {
  text: string;
  lineCount: number;
  truncated: boolean;
  potentialSecret: boolean;
}

export interface SideQuestionResourceInput {
  path: string;
  kind: "file" | "directory";
}

export interface SideQuestionResource {
  path: string;
  kind: "file" | "directory";
}

export interface ResourceSideQuestionContext {
  resources: SideQuestionResource[];
  totalCount: number;
  truncated: boolean;
  containsDirectory: boolean;
}

export type SideQuestionContext =
  | { kind: "terminal"; selection: SanitizedTerminalSelection }
  | { kind: "resources"; resourceContext: ResourceSideQuestionContext };

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
  context: SideQuestionContext | null,
): boolean {
  if (!question.trim() || !context) return false;
  if (context.kind === "terminal") {
    return Boolean(context.selection.text.trim());
  }
  return context.resourceContext.resources.length > 0;
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

export function buildResourceSideQuestionContext(
  projectPath: string,
  entries: SideQuestionResourceInput[],
  maxResources = SIDE_QUESTION_MAX_RESOURCES,
): ResourceSideQuestionContext {
  const normalizedProjectPath = normalizeResourcePath(projectPath).replace(/\/+$/, "");
  const projectPrefix = normalizedProjectPath ? `${normalizedProjectPath}/` : "";
  const uniqueResources = new Map<string, SideQuestionResource>();

  for (const entry of entries) {
    const normalizedPath = normalizeResourcePath(entry.path);
    if (!normalizedPath) continue;
    const relativePath = normalizedPath === normalizedProjectPath
      ? "."
      : projectPrefix && normalizedPath.startsWith(projectPrefix)
        ? normalizedPath.slice(projectPrefix.length)
        : normalizedPath;
    const key = `${entry.kind}:${relativePath}`;
    if (!uniqueResources.has(key)) {
      uniqueResources.set(key, { path: relativePath, kind: entry.kind });
    }
  }

  const allResources = Array.from(uniqueResources.values());
  const safeLimit = Math.max(0, maxResources);
  const resources = allResources.slice(0, safeLimit);

  return {
    resources,
    totalCount: allResources.length,
    truncated: allResources.length > resources.length,
    containsDirectory: resources.some((resource) => resource.kind === "directory"),
  };
}

function normalizeResourcePath(path: string): string {
  return path
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .trim();
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

export function buildResourceSideQuestionPrompt(input: {
  question: string;
  projectPath: string;
  context: ResourceSideQuestionContext;
}): string {
  const serializedResources = JSON.stringify(input.context.resources, null, 2)
    .replaceAll("</project_resources>", "<\\/project_resources>");

  return [
    `工作目录：${input.projectPath}`,
    "以下是用户在 Termflow 文件浏览器中明确选择的项目资源。请根据问题按需读取；对于目录，不要无关地递归读取全部内容。",
    "<project_resources>",
    serializedResources,
    "</project_resources>",
    "",
    "用户问题：",
    input.question.trim(),
  ].join("\n");
}
