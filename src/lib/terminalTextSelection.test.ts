import { describe, expect, it } from "vitest";
import { getTerminalTextSelectionRows } from "./terminalTextSelection";

function lines(text: string[]) {
  return (row: number) => text[row] === undefined ? undefined : {
    getCell: (column: number) => ({
      getChars: () => text[row][column] ?? "",
      getWidth: () => 1,
    }),
  };
}

describe("getTerminalTextSelectionRows", () => {
  it("highlights text without trailing padding, indentation or blank rows", () => {
    expect(getTerminalTextSelectionRows(
      { start: { x: 0, y: 0 }, end: { x: 15, y: 3 } },
      0, 4, 20, lines(["  first line   ", "    ", "", "last"]),
    )).toEqual([
      { row: 0, startColumn: 2, endColumn: 12 },
      { row: 3, startColumn: 0, endColumn: 4 },
    ]);
  });

  it("preserves the selected substring and internal spaces", () => {
    expect(getTerminalTextSelectionRows(
      { start: { x: 2, y: 0 }, end: { x: 7, y: 0 } },
      0, 1, 10, lines(["abc defghi"]),
    )).toEqual([{ row: 0, startColumn: 2, endColumn: 7 }]);
  });

  it("clips rows to the visible viewport after scrolling", () => {
    expect(getTerminalTextSelectionRows(
      { start: { x: 1, y: 0 }, end: { x: 2, y: 4 } },
      2, 2, 10, lines(["a", "b", "ccc", "dddd", "ee"]),
    )).toEqual([
      { row: 0, startColumn: 0, endColumn: 3 },
      { row: 1, startColumn: 0, endColumn: 4 },
    ]);
  });

  it("uses terminal cell widths for CJK and emoji instead of string length", () => {
    const chars = ["你", "", "😀", "", " "];
    expect(getTerminalTextSelectionRows(
      { start: { x: 1, y: 0 }, end: { x: 5, y: 0 } },
      0, 1, 5, () => ({ getCell: (column) => ({
        getChars: () => chars[column],
        getWidth: () => column % 2 === 0 ? 2 : 0,
      }) }),
    )).toEqual([{ row: 0, startColumn: 1, endColumn: 4 }]);
  });

  it("does not highlight the last row when the selection ends at column zero", () => {
    expect(getTerminalTextSelectionRows(
      { start: { x: 0, y: 0 }, end: { x: 0, y: 1 } },
      0, 2, 10, lines(["first", "second"]),
    )).toEqual([{ row: 0, startColumn: 0, endColumn: 5 }]);
  });

  it("skips rows removed from the buffer and selections outside the viewport", () => {
    expect(getTerminalTextSelectionRows(
      { start: { x: 0, y: 0 }, end: { x: 3, y: 1 } },
      0, 2, 10, () => undefined,
    )).toEqual([]);
    expect(getTerminalTextSelectionRows(
      { start: { x: 0, y: 0 }, end: { x: 3, y: 1 } },
      5, 2, 10, lines(["first", "second"]),
    )).toEqual([]);
  });
});
