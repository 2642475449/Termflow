export const STARRY_NIGHT_MAX_CODE_CHARS = 30_000;
export const STARRY_NIGHT_MAX_CODE_LINES = 5_000;

export function getStarryNightLanguageFlag(language?: string): string | null {
  const flag = language?.trim().split(/\s+/)[0]?.toLowerCase();
  return flag || null;
}

export function canHighlightWithStarryNight(code: string): boolean {
  return code.length <= STARRY_NIGHT_MAX_CODE_CHARS
    && code.split("\n").length <= STARRY_NIGHT_MAX_CODE_LINES;
}
