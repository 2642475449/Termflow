import { describe, expect, it } from "vitest";
import { normalizeDecscusrCursorStyle } from "./Terminal";

describe("normalizeDecscusrCursorStyle", () => {
  it.each([
    [undefined, { cursorBlink: false, cursorStyle: "block" }],
    [0, { cursorBlink: false, cursorStyle: "block" }],
    [1, { cursorBlink: false, cursorStyle: "block" }],
    [2, { cursorBlink: false, cursorStyle: "block" }],
    [3, { cursorBlink: false, cursorStyle: "underline" }],
    [4, { cursorBlink: false, cursorStyle: "underline" }],
    [5, { cursorBlink: false, cursorStyle: "bar" }],
    [6, { cursorBlink: false, cursorStyle: "bar" }],
  ] as const)("normalizes DECSCUSR %s", (param, expected) => {
    expect(normalizeDecscusrCursorStyle(param)).toEqual(expected);
  });

  it("ignores unsupported cursor style parameters", () => {
    expect(normalizeDecscusrCursorStyle(99)).toBeNull();
  });
});
