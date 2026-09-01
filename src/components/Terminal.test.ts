import { describe, expect, it } from "vitest";
import {
  keepRunningCursorHidden,
  normalizeDecscusrCursorStyle,
  shouldHideRunningAgentCursor,
} from "./Terminal";

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

describe("keepRunningCursorHidden", () => {
  it("keeps the cursor hidden after each streamed output batch", () => {
    expect(keepRunningCursorHidden("progress", true)).toBe("progress\x1b[?25l");
  });

  it("leaves ordinary terminal output untouched", () => {
    expect(keepRunningCursorHidden("prompt", false)).toBe("prompt");
  });
});

describe("shouldHideRunningAgentCursor", () => {
  it.each(["claude", "codex", "antigravity", "opencode", "qoder", "pi"])(
    "hides the cursor while %s is running",
    (agentId) => {
      expect(shouldHideRunningAgentCursor(agentId, true)).toBe(true);
    },
  );

  it("restores the cursor when an AI agent is waiting for input", () => {
    expect(shouldHideRunningAgentCursor("claude", false)).toBe(false);
  });

  it.each(["powershell", "cmd", undefined])(
    "does not manage cursor visibility for %s",
    (agentId) => {
      expect(shouldHideRunningAgentCursor(agentId, true)).toBe(false);
    },
  );
});
