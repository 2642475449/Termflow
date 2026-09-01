import { describe, expect, it } from "vitest";
import { getGitGraphHoverCardLayout } from "./gitGraphHoverCard";

describe("getGitGraphHoverCardLayout", () => {
  it("uses the available editor width up to the preferred card width", () => {
    expect(getGitGraphHoverCardLayout(
      { top: 360, right: 560 },
      { width: 1440, height: 900 },
      620,
    )).toEqual({
      left: 568,
      top: 288,
      width: 760,
      maxHeight: 600,
    });
  });

  it("shrinks to the space on the right while preserving viewport padding", () => {
    expect(getGitGraphHoverCardLayout(
      { top: 120, right: 570 },
      { width: 1280, height: 720 },
      400,
    )).toEqual({
      left: 578,
      top: 114,
      width: 690,
      maxHeight: 480,
    });
  });

  it("moves left and up when the minimum card size would cross the viewport", () => {
    expect(getGitGraphHoverCardLayout(
      { top: 680, right: 700 },
      { width: 900, height: 720 },
      680,
    )).toEqual({
      left: 428,
      top: 228,
      width: 460,
      maxHeight: 480,
    });
  });

  it("fits inside very small windows instead of enforcing the minimum width", () => {
    expect(getGitGraphHoverCardLayout(
      { top: 20, right: 300 },
      { width: 420, height: 300 },
      500,
    )).toEqual({
      left: 12,
      top: 14,
      width: 396,
      maxHeight: 200,
    });
  });
});
