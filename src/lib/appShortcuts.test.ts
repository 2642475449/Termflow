import { describe, expect, it } from "vitest";
import { createDoubleShiftMatcher, findShortcutConflict, getAppShortcut, isValidAppShortcut, normalizeShortcutOverrides } from "./appShortcuts";
import { matchesShortcut } from "./shortcut";

const keyEvent = (key: string, extra = {}) => ({
  key, type: "keydown", repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra,
}) as KeyboardEvent;

describe("application shortcuts", () => {
  it("keeps defaults for older settings, preserves disabled bindings, and shares the voice setting", () => {
    expect(getAppShortcut({}, "newSession")).toBe("Ctrl + N");
    expect(getAppShortcut({ newSession: "" }, "newSession")).toBe("");
    expect(getAppShortcut({}, "voiceInput", "F8")).toBe("F8");
    expect(normalizeShortcutOverrides(null)).toEqual({});
    expect(normalizeShortcutOverrides({ newSession: "Ctrl+Alt+N", closeTab: "", nextTab: 1, unknown: "F4", voiceInput: "F9" }))
      .toEqual({ newSession: "Ctrl+Alt+N", closeTab: "" });
  });

  it("detects conflicts including defaults, aliases, and the current voice binding", () => {
    expect(findShortcutConflict({}, "newSession", "Control+shift+f", "F8")).toBe("globalTextSearch");
    expect(findShortcutConflict({}, "newSession", "F8", "F8")).toBe("voiceInput");
    expect(findShortcutConflict({ closeTab: "" }, "newSession", "Ctrl+W", "F8")).toBeUndefined();
    expect(findShortcutConflict({}, "newSession", "Ctrl+N", "F8")).toBeUndefined();
    expect(findShortcutConflict({}, "newSession", "", "")).toBeUndefined();
  });

  it("requires deliberate app bindings and protects terminal copy/paste", () => {
    for (const keys of ["A", "Space", "Shift+A", "Escape", "Ctrl+C", "Ctrl+V", "Ctrl+A", "Dead", "F25"]) {
      expect(isValidAppShortcut(keys), keys).toBe(false);
    }
    for (const keys of ["Ctrl+Alt+N", "F8", "Double Shift", "Ctrl+Tab", "Ctrl+,"]) {
      expect(isValidAppShortcut(keys), keys).toBe(true);
    }
  });

  it("matches configured shortcuts precisely on Windows and macOS", () => {
    expect(matchesShortcut(keyEvent("n", { ctrlKey: true }), "Ctrl+Alt+N")).toBe(false);
    expect(matchesShortcut(keyEvent("n", { ctrlKey: true, altKey: true }), "Ctrl+Alt+N")).toBe(true);
    expect(matchesShortcut(keyEvent("n", { metaKey: true, altKey: true }), "Ctrl+Alt+N")).toBe(true);
    expect(matchesShortcut(keyEvent("n", { ctrlKey: true, metaKey: true }), "Ctrl+N")).toBe(false);
    expect(matchesShortcut(keyEvent("n", { ctrlKey: true, metaKey: true }), "Ctrl+Meta+N")).toBe(true);
    expect(matchesShortcut(keyEvent("n", { ctrlKey: true }), "")).toBe(false);
  });

  it("recognizes two Shift taps and resets for intervening shortcuts, repeat, or timeout", () => {
    const match = createDoubleShiftMatcher();
    const down = keyEvent("Shift");
    const up = keyEvent("Shift", { type: "keyup" });
    expect(match(down, 0)).toBe(false);
    expect(match(down, 10)).toBe(false);
    expect(match(up, 20)).toBe(false);
    expect(match(down, 50)).toBe(false);
    expect(match(up, 70)).toBe(true);
    match(down, 80); match(up, 90);
    match(keyEvent("N", { ctrlKey: true }), 100);
    match(down, 110);
    expect(match(up, 120)).toBe(false);
    match(down, 500);
    expect(match(up, 510)).toBe(false);
    expect(match(keyEvent("Shift", { repeat: true }), 520)).toBe(false);
  });
});
