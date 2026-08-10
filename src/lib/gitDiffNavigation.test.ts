import { describe, expect, it } from "vitest";
import {
  findClosestGitHunkIndex,
  getAdjacentDiffIndex,
  getModifiedDiffTargetLine,
} from "./gitDiffNavigation";

describe("git diff navigation", () => {
  it("moves between changes without wrapping past the first or last change", () => {
    expect(getAdjacentDiffIndex(0, 3, "previous")).toBe(0);
    expect(getAdjacentDiffIndex(0, 3, "next")).toBe(1);
    expect(getAdjacentDiffIndex(2, 3, "next")).toBe(2);
    expect(getAdjacentDiffIndex(2, 3, "previous")).toBe(1);
  });

  it("returns no target when a file has no changes", () => {
    expect(getAdjacentDiffIndex(0, 0, "next")).toBe(-1);
  });

  it("prefers the modified-side line and safely handles deletion-only ranges", () => {
    expect(getModifiedDiffTargetLine({
      originalStartLineNumber: 10,
      originalEndLineNumber: 12,
      modifiedStartLineNumber: 11,
      modifiedEndLineNumber: 13,
    })).toBe(11);

    expect(getModifiedDiffTargetLine({
      originalStartLineNumber: 20,
      originalEndLineNumber: 22,
      modifiedStartLineNumber: 0,
      modifiedEndLineNumber: 0,
    })).toBe(20);
  });

  it("maps a Monaco change to the closest Git hunk", () => {
    expect(findClosestGitHunkIndex(
      {
        originalStartLineNumber: 42,
        originalEndLineNumber: 44,
        modifiedStartLineNumber: 43,
        modifiedEndLineNumber: 46,
      },
      [
        { oldStart: 5, oldLines: 4, newStart: 5, newLines: 5 },
        { oldStart: 40, oldLines: 8, newStart: 41, newLines: 9 },
      ],
    )).toBe(1);
  });
});
