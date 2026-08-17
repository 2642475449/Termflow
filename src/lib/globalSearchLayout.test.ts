import { describe, expect, it } from "vitest";
import {
  DEFAULT_GLOBAL_SEARCH_SPLIT_RATIO,
  clampGlobalSearchSplitRatio,
  globalSearchSplitRatioFromPointer,
} from "./globalSearchLayout";

describe("global search vertical split", () => {
  it("converts the pointer position to a percentage", () => {
    expect(globalSearchSplitRatioFromPointer(375, 100, 500)).toBeCloseTo(55);
  });

  it("keeps both panes visible", () => {
    expect(globalSearchSplitRatioFromPointer(100, 100, 500)).toBe(20);
    expect(globalSearchSplitRatioFromPointer(600, 100, 500)).toBe(80);
  });

  it("falls back for invalid geometry", () => {
    expect(globalSearchSplitRatioFromPointer(10, 0, 0)).toBe(DEFAULT_GLOBAL_SEARCH_SPLIT_RATIO);
    expect(clampGlobalSearchSplitRatio(Number.NaN)).toBe(DEFAULT_GLOBAL_SEARCH_SPLIT_RATIO);
  });
});
