import { describe, expect, it } from "vitest";
import {
  STARRY_NIGHT_MAX_CODE_CHARS,
  STARRY_NIGHT_MAX_CODE_LINES,
  canHighlightWithStarryNight,
  getStarryNightLanguageFlag,
} from "./starryNightEligibility";

describe("Starry Night Markdown integration", () => {
  it("uses the first fenced-code language token", () => {
    expect(getStarryNightLanguageFlag(" TypeScript {1,3} ")).toBe("typescript");
    expect(getStarryNightLanguageFlag("  ")).toBeNull();
    expect(getStarryNightLanguageFlag()).toBeNull();
  });

  it("avoids highlighting oversized code blocks", () => {
    expect(canHighlightWithStarryNight("const ready = true;")).toBe(true);
    expect(canHighlightWithStarryNight("x".repeat(STARRY_NIGHT_MAX_CODE_CHARS + 1))).toBe(false);
    expect(canHighlightWithStarryNight("\n".repeat(STARRY_NIGHT_MAX_CODE_LINES))).toBe(false);
  });
});
