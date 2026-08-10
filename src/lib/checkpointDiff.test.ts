import { describe, expect, it } from "vitest";
import type { GitDiffHunk, GitDiffLine } from "@/types";
import {
  buildCollapsedContextSections,
  buildUnifiedCheckpointDiffRows,
} from "./checkpointDiff";

function hunk(lines: Array<[string, string]>): GitDiffHunk {
  return {
    oldStart: 128,
    oldLines: 3,
    newStart: 128,
    newLines: 3,
    header: "@@ -128,3 +128,3 @@",
    lines: lines.map(([origin, content]): GitDiffLine => ({
      origin,
      content,
      oldLineno: null,
      newLineno: null,
    })),
  };
}

describe("buildUnifiedCheckpointDiffRows", () => {
  it("keeps replacement lines sequential and gives each one the full row", () => {
    const rows = buildUnifiedCheckpointDiffRows(hunk([
      ["-", "old A"],
      ["-", "old B"],
      ["+", "new A"],
      ["+", "new B"],
    ]));

    expect(rows).toEqual([
      {
        content: "old A",
        oldLineNumber: 128,
        newLineNumber: null,
        origin: "-",
      },
      {
        content: "old B",
        oldLineNumber: 129,
        newLineNumber: null,
        origin: "-",
      },
      {
        content: "new A",
        oldLineNumber: null,
        newLineNumber: 128,
        origin: "+",
      },
      {
        content: "new B",
        oldLineNumber: null,
        newLineNumber: 129,
        origin: "+",
      },
    ]);
  });

  it("keeps following context numbered on both versions", () => {
    const rows = buildUnifiedCheckpointDiffRows(hunk([
      ["-", "removed A"],
      ["-", "removed B"],
      ["+", "replacement"],
      [" ", "context"],
    ]));

    expect(rows[1]).toEqual({
      content: "removed B",
      oldLineNumber: 129,
      newLineNumber: null,
      origin: "-",
    });
    expect(rows[3]).toEqual({
      content: "context",
      oldLineNumber: 130,
      newLineNumber: 129,
      origin: " ",
    });
  });
});

describe("buildCollapsedContextSections", () => {
  it("builds leading, middle, and trailing unchanged ranges", () => {
    const first = hunk([[" ", "line 3"], ["-", "old 4"], ["+", "new 4"], [" ", "line 5"]]);
    Object.assign(first, { oldStart: 3, newStart: 3, oldLines: 3, newLines: 3 });
    const second = hunk([["-", "old 8"], ["+", "new 8"]]);
    Object.assign(second, { oldStart: 8, newStart: 8, oldLines: 1, newLines: 1 });
    const content = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");

    const sections = buildCollapsedContextSections([first, second], content, content);

    expect(sections.map((section) => ({
      position: section.position,
      lines: section.rows.map((row) => row.content),
    }))).toEqual([
      { position: 0, lines: ["line 1", "line 2"] },
      { position: 1, lines: ["line 6", "line 7"] },
      { position: 2, lines: ["line 9", "line 10"] },
    ]);
    expect(sections[1].rows[0]).toMatchObject({
      oldLineNumber: 6,
      newLineNumber: 6,
      origin: " ",
    });
  });

  it("does not treat a trailing newline as an extra source line", () => {
    const only = hunk([[" ", "line 1"]]);
    Object.assign(only, { oldStart: 1, newStart: 1, oldLines: 1, newLines: 1 });

    const sections = buildCollapsedContextSections(
      [only],
      "line 1\nline 2\n",
      "line 1\nline 2\n",
    );
    expect(sections[0].rows).toHaveLength(1);
  });

  it("does not invent unchanged lines for a newly added file", () => {
    const addition = hunk([["+", "new line"]]);
    Object.assign(addition, { oldStart: 0, newStart: 1, oldLines: 0, newLines: 1 });

    expect(buildCollapsedContextSections(
      [addition],
      "",
      "new line\n",
    )).toEqual([]);
  });
});
