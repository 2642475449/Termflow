import { describe, expect, it } from "vitest";
import {
  adjustSearchWindow,
  DEFAULT_GLOBAL_SEARCH_SPLIT_RATIO,
  clampGlobalSearchSplitRatio,
  globalSearchSplitRatioFromPointer,
} from "./globalSearchLayout";

describe("global search horizontal split", () => {
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

describe("search window geometry", () => {
  const bounds = { left: 100, top: 100, width: 800, height: 500 };
  it("keeps a moved window inside the viewport", () => {
    expect(adjustSearchWindow(bounds, "move", 2000, -2000, 1200, 900))
      .toEqual({ left: 392, top: 8, width: 800, height: 500 });
  });
  it("resizes from the top left while preserving the opposite corner", () => {
    expect(adjustSearchWindow(bounds, "nw", 100, 50, 1200, 900))
      .toEqual({ left: 200, top: 150, width: 700, height: 450 });
  });
  it("enforces minimum and maximum sizes", () => {
    expect(adjustSearchWindow(bounds, "se", -1000, -1000, 1200, 900))
      .toEqual({ left: 100, top: 100, width: 640, height: 360 });
    expect(adjustSearchWindow(bounds, "se", 2000, 2000, 1200, 900))
      .toEqual({ left: 100, top: 100, width: 1092, height: 792 });
  });
  it("fits smaller application windows", () => {
    expect(adjustSearchWindow(bounds, "move", 0, 0, 500, 300))
      .toEqual({ left: 8, top: 8, width: 484, height: 284 });
  });
});
