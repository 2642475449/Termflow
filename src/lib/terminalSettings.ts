export const DEFAULT_TERMINAL_SCROLLBACK = 5_000;

export const TERMINAL_SCROLLBACK_OPTIONS = [5_000, 10_000, 20_000, 50_000] as const;

export function normalizeTerminalScrollback(value: number | null | undefined): number {
  const normalized = Math.round(value ?? DEFAULT_TERMINAL_SCROLLBACK);
  return TERMINAL_SCROLLBACK_OPTIONS.some((option) => option === normalized)
    ? normalized
    : DEFAULT_TERMINAL_SCROLLBACK;
}
