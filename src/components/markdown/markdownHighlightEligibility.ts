export const MARKDOWN_CODE_MAX_CODE_CHARS = 30_000;
export const MARKDOWN_CODE_MAX_CODE_LINES = 5_000;

export function getMarkdownCodeLanguageFlag(language?: string): string | null {
  const flag = language?.trim().split(/\s+/)[0]?.toLowerCase();
  return flag || null;
}

export function canHighlightWithMarkdownCode(code: string): boolean {
  return code.length <= MARKDOWN_CODE_MAX_CODE_CHARS
    && code.split("\n").length <= MARKDOWN_CODE_MAX_CODE_LINES;
}
