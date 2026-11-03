/// <reference lib="es2022.intl" />
import type { ProjectIconPreference } from "@/store/types";

export const PROJECT_ICON_COLORS = [
  "green", "purple", "blue", "amber", "pink", "cyan",
  "red", "orange", "lime", "teal", "indigo", "copper",
] as const;

export function getProjectIconColor(seed: string, count = 12): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  return (hash >>> 0) % count;
}

export function getProjectIconSource(preference: ProjectIconPreference | undefined, detected: string | null | undefined): string | null {
  if (preference?.mode === "image") return preference.image ?? null;
  return !preference || preference.mode === "auto" ? detected ?? null : null;
}

export function isProjectIconEmoji(value: string): boolean {
  const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value.trim())];
  return segments.length === 1 && value.length <= 32 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u.test(value);
}
